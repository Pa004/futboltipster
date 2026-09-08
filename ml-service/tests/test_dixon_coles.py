"""Tests del contrato del modelo Dixon-Coles y de las bandas de confianza."""

import sys
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.models.dixon_coles import CONFIDENCE_BANDS, DixonColes, confidence_bands, confidence_label

TEAMS = ["Alfa", "Beta", "Gamma", "Delta"]
N = 400
RNG = np.random.default_rng(7)


def synthetic_fit():
    """Dataset sintético con ventaja local clara (Alfa gana casi siempre en casa)."""
    rng = RNG
    strength = {t: i for i, t in enumerate(TEAMS)}
    dates, home, away, gh, ga = [], [], [], [], []
    for _ in range(N):
        h = TEAMS[rng.integers(4)]
        a = TEAMS[rng.integers(4)]
        if h == a:
            continue
        lam_h = max(1.5 + 0.4 * (strength[h] - strength[a]) + 0.3, 0.1)
        lam_a = max(1.2 + 0.4 * (strength[a] - strength[h]), 0.1)
        dates.append(pd.Timestamp("2024-01-01") + pd.Timedelta(days=int(rng.integers(0, 300))))
        home.append(h)
        away.append(a)
        gh.append(rng.poisson(lam_h))
        ga.append(rng.poisson(lam_a))
    model = DixonColes()
    model.fit(np.array(dates), home, away, gh, ga)
    return model


def test_confidence_label_boundaries():
    assert confidence_label(0.65)["level"] == "seguro"
    assert confidence_label(0.6499)["level"] == "probable"
    assert confidence_label(0.55)["level"] == "probable"
    assert confidence_label(0.5499)["level"] == "ajustado"
    assert confidence_label(0.45)["level"] == "ajustado"
    assert confidence_label(0.3)["level"] == "incierto"
    assert [b[2] for b in CONFIDENCE_BANDS] == [0.65, 0.55, 0.45]


def test_confidence_bands_ranges():
    bands = confidence_bands()
    by_level = {b["level"]: b for b in bands}
    assert by_level["seguro"] == {"level": "seguro", "label": "Seguro", "lo": 0.65, "hi": 1.01}
    assert by_level["probable"] == {
        "level": "probable",
        "label": "Probable",
        "lo": 0.55,
        "hi": 0.65,
    }
    assert by_level["ajustado"] == {
        "level": "ajustado",
        "label": "Ajustado",
        "lo": 0.45,
        "hi": 0.55,
    }
    assert by_level["incierto"] == {"level": "incierto", "label": "Incierto", "lo": 0.0, "hi": 0.45}
    # las bandas cubren [0, 1.01) sin huecos ni solapes
    ranges = sorted((b["lo"], b["hi"]) for b in bands)
    assert ranges[0][0] == 0.0
    for (_, hi), (lo2, _) in zip(ranges, ranges[1:], strict=False):
        assert hi == lo2


def test_predict_contract():
    model = synthetic_fit()
    p = model.predict("Alfa", "Beta")
    probs = p["probabilities"]
    assert sum(probs.values()) == pytest.approx(1.0, abs=1e-6)
    assert p["pick"] in {"H", "D", "A"}
    assert p["confidence"]["probability"] == pytest.approx(max(probs.values()), abs=1e-3)
    assert p["over_25"] + p["under_25"] == pytest.approx(1.0)
    assert 0 <= p["btts_yes"] <= 1
    mat = p["score_matrix"]
    assert len(mat) == 6 and len(mat[0]) == 6  # 6x6 para el heatmap
    assert all(0 <= cell <= 1 for row in mat for cell in row)
    # la submatriz mostrada no alcanza 1 porque el resto del tail queda fuera
    assert sum(cell for row in mat for cell in row) < 1.0


def test_home_advantage_reflected():
    model = synthetic_fit()
    p = model.predict("Delta", "Alfa")  # el más fuerte en casa contra el más débil fuera
    assert p["expected_goals"]["home"] > p["expected_goals"]["away"]


def test_save_load_roundtrip(tmp_path):
    model = synthetic_fit()
    path = str(tmp_path / "model.npz")
    model.save(path)
    loaded = DixonColes.load(path)
    assert loaded.teams == model.teams
    before = model.predict("Alfa", "Beta")
    after = loaded.predict("Alfa", "Beta")
    assert before["probabilities"] == pytest.approx(after["probabilities"])
    assert loaded.n_matches == model.n_matches
    data = np.load(path, allow_pickle=True)
    assert "saved_at" in data and "n_matches" in data  # metadata versionada
    assert int(data["n_matches"][0]) > 0


def test_small_sample_predice_con_poquitos_partidos():
    """Liga con poca historia (caso EC1): el modelo ajusta y predice 1X2 válido."""
    dates = [pd.Timestamp("2024-02-01"), pd.Timestamp("2024-02-08"), pd.Timestamp("2024-02-15")]
    home = ["Barcelona SC", "Emelec", "Liga de Quito"]
    away = ["Emelec", "Liga de Quito", "Barcelona SC"]
    gh = [2, 0, 1]
    ga = [0, 0, 1]
    model = DixonColes()
    model.fit(np.array(dates), home, away, gh, ga)
    p = model.predict("Barcelona SC", "Emelec")
    assert p["pick"] in {"H", "D", "A"}
    assert sum(p["probabilities"].values()) == pytest.approx(1.0, abs=1e-6)
    assert "Barcelona SC" in model.teams and "Emelec" in model.teams


def test_score_matrix_usa_lambdas_truncadas_en_tau():
    """Bloqueo del quirk de full_like: score_matrix trunca las lambdas a int
    dentro de tau (x es entero). Si alguien lo "corrige" a floats, este test
    falla a propósito: cambiarlo altera todas las predicciones."""
    from scipy.stats import poisson

    from app.models.dixon_coles import MAX_GOALS

    model = DixonColes()
    model.teams = ["Alfa", "Beta"]
    model.idx = {"Alfa": 0, "Beta": 1}
    model.attack = np.array([0.1, -0.1])
    model.defense = np.array([0.05, -0.05])
    model.mu = 0.2
    model.gamma = 0.15
    model.rho = -0.05
    lam_h = model._lam_home("Alfa", "Beta")
    lam_a = model._lam_away("Alfa", "Beta")
    assert lam_h > 1 and lam_a > 1  # el truncado difiere del flotante

    def manual(th, ta):
        n = MAX_GOALS + 1
        xs, ys = np.meshgrid(np.arange(n), np.arange(n), indexing="ij")
        t = np.ones((n, n))
        t[(xs == 0) & (ys == 0)] = 1 - th * ta * model.rho
        t[(xs == 0) & (ys == 1)] = 1 + th * model.rho
        t[(xs == 1) & (ys == 0)] = 1 + ta * model.rho
        t[(xs == 1) & (ys == 1)] = 1 - model.rho
        probs = poisson.pmf(xs, lam_h) * poisson.pmf(ys, lam_a) * t
        return probs / probs.sum()

    mat = model.score_matrix("Alfa", "Beta")
    np.testing.assert_allclose(mat, manual(int(lam_h), int(lam_a)), rtol=1e-12, atol=1e-12)
    assert not np.allclose(manual(lam_h, lam_a), mat, rtol=1e-12, atol=1e-12)


def test_score_matrix_predict_es_la_completa_recortada():
    """predict expone la submatriz 6x6 del heatmap; la matriz completa se
    conserva en score_matrix (los mercados de matriz necesitan la cola)."""
    from app.models.dixon_coles import HEATMAP_GOALS

    model = synthetic_fit()
    full = model.score_matrix("Alfa", "Beta")
    assert full.shape == (model.max_goals + 1, model.max_goals + 1)
    shown = model.predict("Alfa", "Beta")["score_matrix"]
    assert np.array(shown).shape == (HEATMAP_GOALS, HEATMAP_GOALS)
    assert np.array(shown) == pytest.approx(full[:HEATMAP_GOALS, :HEATMAP_GOALS])
