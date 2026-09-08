// Port de inferencia de ml-service/app/models/dixon_coles.py (sin fit).
// Poisson en espacio logarítmico: nunca produce NaN (scipy devuelve 0.0 en los
// mismos extremos), así que la rama de fallback uniforme se conserva idéntica.
export const MAX_GOALS = 8;
export const HEATMAP_GOALS = 6;

export interface DixonColesData {
  teams: string[];
  attack: number[];
  defense: number[];
  mu: number;
  gamma: number;
  rho: number;
  saved_at: string;
}

export interface DixonColesModel extends DixonColesData {
  idx: Map<string, number>;
}

export function loadDixonColes(data: DixonColesData): DixonColesModel {
  const idx = new Map<string, number>();
  data.teams.forEach((t, i) => idx.set(t, i));
  return { ...data, idx };
}

const FACTORIAL: number[] = [1, 1, 2, 6, 24, 120, 720, 5040, 40320];

function logFactorial(k: number): number {
  if (k < FACTORIAL.length) return Math.log(FACTORIAL[k]);
  let acc = Math.log(FACTORIAL[FACTORIAL.length - 1]);
  for (let i = FACTORIAL.length; i <= k; i++) acc += Math.log(i);
  return acc;
}

export function poissonPmf(k: number, lam: number): number {
  if (lam <= 0) return k === 0 ? 1 : 0;
  return Math.exp(-lam + k * Math.log(lam) - logFactorial(k));
}

function tau(rho: number, lamH: number, lamA: number, x: number, y: number): number {
  let out = 1;
  if (x === 0 && y === 0) out = 1 - lamH * lamA * rho;
  else if (x === 0 && y === 1) out = 1 + lamH * rho;
  else if (x === 1 && y === 0) out = 1 + lamA * rho;
  else if (x === 1 && y === 1) out = 1 - rho;
  return Math.min(Math.max(out, 1e-6), Infinity);
}

function rateOf(model: DixonColesModel, team: string, attr: "attack" | "defense"): number {
  const i = model.idx.get(team);
  if (i === undefined) return 0;
  return attr === "attack" ? model.attack[i] : model.defense[i];
}

function clip700(x: number): number {
  return Math.min(Math.max(x, -700), 700);
}

export function lamHome(model: DixonColesModel, home: string, away: string): number {
  return Math.exp(clip700(model.mu + rateOf(model, home, "attack") + rateOf(model, away, "defense") + model.gamma));
}

export function lamAway(model: DixonColesModel, home: string, away: string): number {
  return Math.exp(clip700(model.mu + rateOf(model, away, "attack") + rateOf(model, home, "defense")));
}

export type ScoreMatrix = number[][];

export function scoreMatrix(model: DixonColesModel, home: string, away: string): ScoreMatrix {
  const lamH = lamHome(model, home, away);
  const lamA = lamAway(model, home, away);
  // Quirk replicado de Python: score_matrix envuelve las lambdas con
  // np.full_like(x, lam) donde x es entero, así que tau opera con las lambdas
  // truncadas a int. Cambiarlo alteraría todas las predicciones: se preserva.
  const tauH = Math.trunc(lamH);
  const tauA = Math.trunc(lamA);
  const n = MAX_GOALS + 1;
  const mat: ScoreMatrix = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  let total = 0;
  for (let x = 0; x < n; x++) {
    for (let y = 0; y < n; y++) {
      const p = poissonPmf(x, lamH) * poissonPmf(y, lamA) * tau(model.rho, tauH, tauA, x, y);
      mat[x][y] = p;
      total += p;
    }
  }
  if (!Number.isFinite(total) || total <= 0) {
    // Lambdas degeneradas: distribución uniforme (misma rama que Python).
    return Array.from({ length: n }, () => new Array<number>(n).fill(1 / n / n));
  }
  for (let x = 0; x < n; x++) {
    for (let y = 0; y < n; y++) mat[x][y] /= total;
  }
  return mat;
}

export interface DixonColesPrediction {
  probabilities: { home: number; draw: number; away: number };
  scoreline: { home: number; away: number; probability: number };
  over_25: number;
  under_25: number;
  btts_yes: number;
  btts_no: number;
  expected_goals: { home: number; away: number };
  pick: "H" | "D" | "A";
  confidence: { level: string; label: string; probability: number };
  score_matrix: number[][];
}

export function confidenceLabel(p: number): { level: string; label: string; probability: number } {
  if (p >= 0.65) return { level: "seguro", label: "Seguro", probability: p };
  if (p >= 0.55) return { level: "probable", label: "Probable", probability: p };
  if (p >= 0.45) return { level: "ajustado", label: "Ajustado", probability: p };
  return { level: "incierto", label: "Incierto", probability: p };
}

export function predictDixonColes(
  model: DixonColesModel,
  home: string,
  away: string,
  mat?: ScoreMatrix,
): DixonColesPrediction {
  const m = mat ?? scoreMatrix(model, home, away);
  const n = m.length;
  let pHome = 0;
  let pAway = 0;
  let pDraw = 0;
  let pOver25 = 0;
  let pBtts = 0;
  // Recorrido row-major: el primer máximo coincide con np.where(max)[0].
  let best = -1;
  let bestH = 0;
  let bestA = 0;
  for (let x = 0; x < n; x++) {
    for (let y = 0; y < n; y++) {
      const p = m[x][y];
      if (x > y) pHome += p;
      else if (x < y) pAway += p;
      else pDraw += p;
      if (x + y >= 3) pOver25 += p;
      if (x >= 1 && y >= 1) pBtts += p;
      if (x < HEATMAP_GOALS && y < HEATMAP_GOALS && p > best) {
        best = p;
        bestH = x;
        bestA = y;
      }
    }
  }
  const mostLikely = Math.max(pHome, pDraw, pAway);
  // Desempate idéntico a Python (== en float): H, luego D, luego A.
  const pick: "H" | "D" | "A" = mostLikely === pHome ? "H" : mostLikely === pDraw ? "D" : "A";
  const lamH = lamHome(model, home, away);
  const lamA = lamAway(model, home, away);
  return {
    probabilities: { home: pHome, draw: pDraw, away: pAway },
    scoreline: { home: bestH, away: bestA, probability: best },
    over_25: pOver25,
    under_25: 1 - pOver25,
    btts_yes: pBtts,
    btts_no: 1 - pBtts,
    expected_goals: { home: lamH, away: lamA },
    pick,
    confidence: confidenceLabel(mostLikely),
    score_matrix: m.slice(0, HEATMAP_GOALS).map((row) => row.slice(0, HEATMAP_GOALS)),
  };
}
