// Port de inferencia de ml-service/app/models/count_model.py (solo predict).
// nbinom.pmf vía log-gamma de Lanczos (sin scipy).
export const MAX_COUNT = 30;

export interface CountModelData {
  teams: string[];
  attack: number[];
  defense: number[];
  mu: number;
  gamma: number;
  form: number[];
  form_beta: number;
  alpha_od: number;
  saved_at: string;
}

export interface CountModel extends CountModelData {
  idx: Map<string, number>;
}

export function loadCountModel(data: CountModelData): CountModel {
  const idx = new Map<string, number>();
  data.teams.forEach((t, i) => idx.set(t, i));
  return { ...data, idx };
}

// Log-gamma de Lanczos (g=7, 9 coeficientes): error ~1e-15 para x > 0.
const LANCZOS = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
  -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
  1.5056327351493116e-7,
];

export function logGamma(x: number): number {
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  const z = x - 1;
  let acc = LANCZOS[0];
  for (let i = 1; i < 9; i++) acc += LANCZOS[i] / (z + i);
  const t = z + 7.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(acc);
}

export function nbinomPmf(k: number, r: number, p: number): number {
  const logP = logGamma(k + r) - logGamma(k + 1) - logGamma(r) + r * Math.log(p) + k * Math.log(1 - p);
  return Math.exp(logP);
}

function rateOf(model: CountModel, team: string, attr: "attack" | "defense" | "form"): number {
  const i = model.idx.get(team);
  if (i === undefined) return 0;
  if (attr === "attack") return model.attack[i];
  if (attr === "defense") return model.defense[i];
  return model.form[i];
}

function clip700(x: number): number {
  return Math.min(Math.max(x, -700), 700);
}

export function countLam(
  model: CountModel,
  home: string,
  away: string,
  side: "home" | "away",
  formOverride?: number,
): number {
  const formOf = (team: string): number =>
    formOverride !== undefined ? formOverride : rateOf(model, team, "form");
  const lin =
    side === "home"
      ? model.mu + rateOf(model, home, "attack") + rateOf(model, away, "defense") + model.gamma + model.form_beta * formOf(home)
      : model.mu + rateOf(model, away, "attack") + rateOf(model, home, "defense") + model.form_beta * formOf(away);
  return Math.exp(clip700(lin));
}

export interface CountPrediction {
  pmf_home: number[];
  pmf_away: number[];
  expected: { home: number; away: number };
  alpha: number;
}

export function predictCount(
  model: CountModel,
  home: string,
  away: string,
  formHome?: number,
  formAway?: number,
): CountPrediction {
  const lamH = countLam(model, home, away, "home", formHome);
  const lamA = countLam(model, home, away, "away", formAway);
  const r = 1 / model.alpha_od;
  const pmfHome: number[] = [];
  const pmfAway: number[] = [];
  let sumH = 0;
  let sumA = 0;
  for (let k = 0; k <= MAX_COUNT; k++) {
    const ph = nbinomPmf(k, r, r / (r + lamH));
    const pa = nbinomPmf(k, r, r / (r + lamA));
    pmfHome.push(ph);
    pmfAway.push(pa);
    sumH += ph;
    sumA += pa;
  }
  return {
    pmf_home: pmfHome.map((p) => p / sumH),
    pmf_away: pmfAway.map((p) => p / sumA),
    expected: { home: lamH, away: lamA },
    alpha: model.alpha_od,
  };
}
