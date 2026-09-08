// Port de ml-service/app/models/markets.py (todo puro, sin numpy).
export const RESULT_LABELS = ["H", "D", "A"];

export const FT_LINES = [0.5, 1.5, 2.5, 3.5, 4.5];
export const AH_LINES = [-1.5, -1.0, -0.5, 0.0, 0.5, 1.0, 1.5];
export const TEAM_TOTAL_LINES = [0.5, 1.5, 2.5];
export const HT_LINES = [0.5, 1.5];

export const COUNT_GROUPS: Record<string, { total: number[]; team: number[]; handicap: number[] }> = {
  corners: { total: [8.5, 9.5, 10.5], team: [3.5, 4.5, 5.5], handicap: [-2.5, -1.5] },
  bookings: { total: [3.5, 4.5, 5.5], team: [1.5, 2.5], handicap: [-1.5, -0.5] },
  shots_on_target: { total: [8.5], team: [3.5, 4.5], handicap: [-2.5, -1.5] },
  fouls: { total: [20.5, 22.5], team: [9.5, 10.5], handicap: [-2.5] },
};

// Réplica de f"{line:g}": enteros sin decimal ("-1", "0"), resto tal cual ("8.5").
export function formatLine(line: number): string {
  return Number.isInteger(line) ? String(line) : String(line);
}

export interface OverUnder {
  over: number;
  under: number;
}

function overFromMarginal(marg: number[], line: number): number {
  let over = 0;
  let equal = 0;
  for (let i = 0; i < marg.length; i++) {
    if (i > line) over += marg[i];
    else if (i === line && Number.isInteger(line)) equal += marg[i];
  }
  return over + 0.5 * equal;
}

export function doubleChance(probs: { home: number; draw: number; away: number }): Record<string, number> {
  const { home, draw, away } = probs;
  return { "1X": home + draw, "12": home + away, X2: draw + away };
}

export function totalMarkets(mat: number[][], lines: number[]): Record<string, OverUnder> {
  const n = mat.length;
  const out: Record<string, OverUnder> = {};
  for (const line of lines) {
    let over = 0;
    for (let x = 0; x < n; x++) {
      for (let y = 0; y < n; y++) {
        if (x + y >= line) over += mat[x][y];
      }
    }
    out[formatLine(line)] = { over, under: 1 - over };
  }
  return out;
}

export function asianHandicap(mat: number[][], lines: number[]): Record<string, { home_cover: number }> {
  const n = mat.length;
  const out: Record<string, { home_cover: number }> = {};
  for (const h of lines) {
    let cover = 0;
    const integer = Number.isInteger(h);
    for (let x = 0; x < n; x++) {
      for (let y = 0; y < n; y++) {
        const m = x - y + h;
        if (m > 0) cover += mat[x][y];
        else if (m === 0 && integer) cover += 0.5 * mat[x][y];
      }
    }
    out[formatLine(h)] = { home_cover: cover };
  }
  return out;
}

export function oddEven(mat: number[][]): { odd: number; even: number } {
  const n = mat.length;
  let odd = 0;
  for (let x = 0; x < n; x++) {
    for (let y = 0; y < n; y++) {
      if ((x + y) % 2 === 1) odd += mat[x][y];
    }
  }
  return { odd, even: 1 - odd };
}

export function teamTotals(
  mat: number[][],
  lines: number[],
): Record<string, { home_over: number; away_over: number }> {
  const n = mat.length;
  const homeMarg = new Array<number>(n).fill(0);
  const awayMarg = new Array<number>(n).fill(0);
  for (let x = 0; x < n; x++) {
    for (let y = 0; y < n; y++) {
      homeMarg[x] += mat[x][y];
      awayMarg[y] += mat[x][y];
    }
  }
  const out: Record<string, { home_over: number; away_over: number }> = {};
  for (const line of lines) {
    out[formatLine(line)] = {
      home_over: overFromMarginal(homeMarg, line),
      away_over: overFromMarginal(awayMarg, line),
    };
  }
  return out;
}

export function cleanSheet(mat: number[][]): { home: number; away: number } {
  const n = mat.length;
  let homeMarg0 = 0;
  let awayMarg0 = 0;
  for (let x = 0; x < n; x++) {
    awayMarg0 += mat[x][0];
    homeMarg0 += mat[0][x];
  }
  return { home: awayMarg0, away: homeMarg0 };
}

export interface CorrectScore {
  home: number;
  away: number;
  prob: number;
}

export function correctScoreTop(mat: number[][], k = 8): CorrectScore[] {
  const n = mat.length;
  const cells: CorrectScore[] = [];
  for (let x = 0; x < n; x++) {
    for (let y = 0; y < n; y++) cells.push({ home: x, away: y, prob: mat[x][y] });
  }
  // Orden row-major ante empates: con floats reales los empates exactos no ocurren.
  cells.sort((a, b) => b.prob - a.prob);
  return cells.slice(0, k);
}

export interface HtFtCell {
  ht: string;
  ft: string;
  prob: number;
}

export function htFtMarkets(htProbs: number[], cond: number[][]): HtFtCell[] {
  const joint: number[][] = [];
  let total = 0;
  for (let i = 0; i < 3; i++) {
    joint.push([]);
    for (let j = 0; j < 3; j++) {
      const p = htProbs[i] * cond[i][j];
      joint[i].push(p);
      total += p;
    }
  }
  const out: HtFtCell[] = [];
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      out.push({ ht: RESULT_LABELS[i], ft: RESULT_LABELS[j], prob: joint[i][j] / total });
    }
  }
  return out;
}

export function totalMarketsPmf(pmfHome: number[], pmfAway: number[], lines: number[]): Record<string, OverUnder> {
  const total = new Array<number>(pmfHome.length + pmfAway.length - 1).fill(0);
  for (let i = 0; i < pmfHome.length; i++) {
    for (let j = 0; j < pmfAway.length; j++) total[i + j] += pmfHome[i] * pmfAway[j];
  }
  const out: Record<string, OverUnder> = {};
  for (const line of lines) {
    let over = 0;
    for (let t = 0; t < total.length; t++) {
      if (t >= line) over += total[t];
    }
    out[formatLine(line)] = { over, under: 1 - over };
  }
  return out;
}

export function teamTotalsPmf(
  pmfHome: number[],
  pmfAway: number[],
  lines: number[],
): Record<string, { home_over: number; away_over: number }> {
  const out: Record<string, { home_over: number; away_over: number }> = {};
  for (const line of lines) {
    out[formatLine(line)] = {
      home_over: overFromMarginal(pmfHome, line),
      away_over: overFromMarginal(pmfAway, line),
    };
  }
  return out;
}

export function mostMarkets(pmfHome: number[], pmfAway: number[]): { home: number; draw: number; away: number } {
  let home = 0;
  let draw = 0;
  let away = 0;
  for (let i = 0; i < pmfHome.length; i++) {
    for (let j = 0; j < pmfAway.length; j++) {
      const p = pmfHome[i] * pmfAway[j];
      if (i > j) home += p;
      else if (i < j) away += p;
      else draw += p;
    }
  }
  return { home, draw, away };
}

export function countHandicap(
  pmfHome: number[],
  pmfAway: number[],
  lines: number[],
): Record<string, { home_cover: number }> {
  const out: Record<string, { home_cover: number }> = {};
  for (const h of lines) {
    let cover = 0;
    const integer = Number.isInteger(h);
    for (let i = 0; i < pmfHome.length; i++) {
      for (let j = 0; j < pmfAway.length; j++) {
        const m = i - j + h;
        if (m > 0) cover += pmfHome[i] * pmfAway[j];
        else if (m === 0 && integer) cover += 0.5 * pmfHome[i] * pmfAway[j];
      }
    }
    out[formatLine(h)] = { home_cover: cover };
  }
  return out;
}

export function firstEvent(lamHome: number, lamAway: number): { home: number; away: number; none: number } {
  const total = lamHome + lamAway;
  if (total <= 1e-9) return { home: 0, away: 0, none: 1 };
  const pSome = 1 - Math.exp(-total);
  return {
    home: (lamHome / total) * pSome,
    away: (lamAway / total) * pSome,
    none: Math.exp(-total),
  };
}
