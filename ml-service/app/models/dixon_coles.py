"""Modelo Dixon-Coles (1997): Poisson bivariado con correccion tau.

lambda_home = exp(alpha_home + beta_away + gamma)
lambda_away = exp(alpha_away + beta_home)

alpha: ataque, beta: defensa, gamma: ventaja local,
rho: correccion de marcadores bajos (tau).
Ajuste por maxima verosimilitud con decaimiento temporal.
"""

from __future__ import annotations

import numpy as np
from scipy.optimize import minimize
from scipy.stats import poisson

DEFAULT_DECAY = 0.0025
MAX_GOALS = 8
HEATMAP_GOALS = 6  # la UI dibuja 6x6; el resto de la matriz se usa solo para cálculos

# Umbrales de confianza: el pick cuyo max(p_home, p_draw, p_away) >= umbral cae en
# esa banda, con límite inferior inclusivo. Fuente de verdad; el server la consume
# via GET /bands (confidence_bands()) y el web por nivel (lowercase).
CONFIDENCE_BANDS = [
    ("seguro", "Seguro", 0.65),
    ("probable", "Probable", 0.55),
    ("ajustado", "Ajustado", 0.45),
]


def confidence_bands() -> list[dict[str, float | str]]:
    """Rangos explícitos de confianza (lo incluido, hi excluido) derivados de
    CONFIDENCE_BANDS, incluida la banda de cola "incierto" [0, umbral mínimo).
    El techo de la banda superior usa 1.01 para incluir p == 1.0."""
    thresholds = sorted(b[2] for b in CONFIDENCE_BANDS)
    bands: list[dict[str, float | str]] = []
    for level, label, threshold in CONFIDENCE_BANDS:
        upper = next((t for t in thresholds if t > threshold), 1.01)
        bands.append({"level": level, "label": label, "lo": threshold, "hi": upper})
    bands.append({"level": "incierto", "label": "Incierto", "lo": 0.0, "hi": thresholds[0]})
    return bands


class DixonColes:
    def __init__(self, decay: float = DEFAULT_DECAY, max_goals: int = MAX_GOALS) -> None:
        self.decay = decay
        self.max_goals = max_goals
        self.teams: list[str] = []
        self.idx: dict[str, int] = {}
        self.attack: np.ndarray = np.array([])
        self.defense: np.ndarray = np.array([])
        self.mu = 0.0
        self.gamma = 0.0
        self.rho = 0.0

    def fit(self, dates, home_team, away_team, home_goals, away_goals) -> None:
        teams = sorted(set(home_team) | set(away_team))
        self.teams = teams
        self.idx = {t: i for i, t in enumerate(teams)}
        self.n_matches = len(home_team)
        n = len(teams)
        i_home = np.array([self.idx[t] for t in home_team])
        i_away = np.array([self.idx[t] for t in away_team])

        ref = max(dates)
        age_days = np.array([(ref - d).days for d in dates], dtype=float)
        weights = np.exp(-self.decay * age_days)

        # Intercepto mu + equipo de referencia fijo: rompe la degeneracion de
        # desplazamiento alpha+c / beta-c que dejaba el nivel mal determinado.
        free = n - 1

        def unpack(p):
            mu = p[0]
            attack_free = p[1 : 1 + free]
            defense_free = p[1 + free : 1 + 2 * free]
            gamma = p[1 + 2 * free]
            rho = p[2 + 2 * free]
            return mu, attack_free, defense_free, gamma, rho

        def nll(p) -> float:
            mu, attack_free, defense_free, gamma, rho = unpack(p)
            att = np.concatenate([[0.0], attack_free])
            de = np.concatenate([[0.0], defense_free])
            lam_h = np.exp(np.clip(mu + att[i_home] + de[i_away] + gamma, -700, 700))
            lam_a = np.exp(np.clip(mu + att[i_away] + de[i_home], -700, 700))
            tau = self._tau(rho, lam_h, lam_a, home_goals, away_goals)
            like = poisson.pmf(home_goals, lam_h) * poisson.pmf(away_goals, lam_a) * tau
            like = np.clip(like, 1e-12, None)
            return -float(np.sum(weights * np.log(like)))

        base_rate = 0.5 * (float(np.mean(home_goals)) + float(np.mean(away_goals)))
        p0 = np.concatenate([[np.log(max(base_rate, 1e-3))], np.zeros(2 * free), [0.2], [0.0]])
        res = minimize(
            nll,
            p0,
            method="L-BFGS-B",
            options={"maxiter": 2000},
        )
        mu, attack_free, defense_free, self.gamma, self.rho = unpack(res.x)
        self.mu = float(mu)
        self.attack = np.concatenate([[0.0], attack_free])
        self.defense = np.concatenate([[0.0], defense_free])

    def _tau(self, rho, lam_h, lam_a, x, y) -> np.ndarray:
        out = np.ones_like(x, dtype=float)
        zero = (x == 0) & (y == 0)
        one = (x == 0) & (y == 1)
        two = (x == 1) & (y == 0)
        three = (x == 1) & (y == 1)
        out[zero] = 1 - lam_h[zero] * lam_a[zero] * rho
        out[one] = 1 + lam_h[one] * rho
        out[two] = 1 + lam_a[two] * rho
        out[three] = 1 - rho
        return np.clip(out, 1e-6, None)

    def score_matrix(self, home: str, away: str) -> np.ndarray:
        lam_h = self._lam_home(home, away)
        lam_a = self._lam_away(home, away)
        max_g = self.max_goals
        grid_x, grid_y = np.meshgrid(np.arange(max_g + 1), np.arange(max_g + 1), indexing="ij")
        x = grid_x.ravel()
        y = grid_y.ravel()
        # Quirk intencional y load-bearing: x es entero, así que np.full_like(x, lam)
        # trunca las lambdas a int dentro de tau. Cambiarlo altera todas las
        # predicciones (ver test_score_matrix_usa_lambdas_truncadas_en_tau); el
        # port TypeScript del Worker lo replica con Math.trunc.
        tau = self._tau(self.rho, np.full_like(x, lam_h), np.full_like(x, lam_a), x, y)
        probs = (poisson.pmf(x, lam_h) * poisson.pmf(y, lam_a) * tau).reshape(max_g + 1, max_g + 1)
        total = probs.sum()
        if not np.isfinite(total) or total <= 0:
            # Lambdas degeneradas (equipo sin datos suficientes): distribucion
            # uniforme para no romper los mercados derivados de la matriz.
            return np.full((max_g + 1, max_g + 1), 1.0 / (max_g + 1) ** 2)
        return probs / total

    def save(self, path: str) -> None:
        np.savez(
            path,
            teams=np.array(self.teams),
            attack=self.attack,
            defense=self.defense,
            mu=np.array([self.mu]),
            gamma=np.array([self.gamma]),
            rho=np.array([self.rho]),
            n_matches=np.array([self.n_matches]),
            saved_at=np.array([np.datetime64("now", "s")]),
        )

    @classmethod
    def load(cls, path: str) -> DixonColes:
        data = np.load(path)
        model = cls()
        model.teams = [str(t) for t in data["teams"]]
        model.idx = {t: i for i, t in enumerate(model.teams)}
        model.attack = data["attack"]
        model.defense = data["defense"]
        model.mu = float(data["mu"][0])
        model.gamma = float(data["gamma"][0])
        model.rho = float(data["rho"][0])
        model.n_matches = int(data["n_matches"][0])
        return model

    def _lam_home(self, home: str, away: str) -> float:
        lin = self.mu + self._rate(home, "attack") + self._rate(away, "defense") + self.gamma
        return float(np.exp(np.clip(lin, -700, 700)))

    def _lam_away(self, home: str, away: str) -> float:
        lin = self.mu + self._rate(away, "attack") + self._rate(home, "defense")
        return float(np.exp(np.clip(lin, -700, 700)))

    def _rate(self, team: str, attr: str) -> float:
        i = self.idx.get(team)
        if i is None:
            return 0.0
        return float(getattr(self, attr)[i])

    def predict(self, home: str, away: str, score_matrix: np.ndarray | None = None) -> dict:
        # La matriz se calcula una sola vez: build_prediction la comparte con predict
        mat = self.score_matrix(home, away) if score_matrix is None else score_matrix
        p_home = float(mat[np.tril_indices_from(mat, -1)].sum())
        p_away = float(mat[np.triu_indices_from(mat, 1)].sum())
        p_draw = float(np.trace(mat))
        heat = mat[:HEATMAP_GOALS, :HEATMAP_GOALS]
        home_idx, away_idx = np.where(heat == heat.max())
        scoreline = (int(home_idx[0]), int(away_idx[0]))
        goals = np.arange(mat.shape[0])
        mask_over25 = (goals[:, None] + goals[None, :]) >= 3
        p_over25 = float(mat[mask_over25].sum())
        p_btts = float(mat[1:, 1:].sum())
        most_likely = max([p_home, p_draw, p_away])
        if most_likely == p_home:
            pick = "H"
        elif most_likely == p_draw:
            pick = "D"
        else:
            pick = "A"
        return {
            "probabilities": {"home": p_home, "draw": p_draw, "away": p_away},
            "scoreline": {
                "home": scoreline[0],
                "away": scoreline[1],
                "probability": float(heat.max()),
            },
            "over_25": p_over25,
            "under_25": 1 - p_over25,
            "btts_yes": p_btts,
            "btts_no": 1 - p_btts,
            "expected_goals": {
                "home": self._lam_home(home, away),
                "away": self._lam_away(home, away),
            },
            "pick": pick,
            "confidence": confidence_label(most_likely),
            "score_matrix": mat[:HEATMAP_GOALS, :HEATMAP_GOALS].tolist(),
        }


def confidence_label(p: float) -> dict:
    for level, label, threshold in CONFIDENCE_BANDS:
        if p >= threshold:
            return {"level": level, "label": label, "probability": float(p)}
    return {"level": "incierto", "label": "Incierto", "probability": float(p)}
