import { ML_URL } from "./config.js";
import { TEAM_OVERRIDES } from "./data/teamOverrides.js";

// Caché por liga: el modelo global (default) y el de Liga Pro (EC1) son
// espacios de nombres distintos en el ml-service (/teams?league=).
const cache = new Map<string, { teams: string[]; cachedAt: number }>();
const inflight = new Map<string, Promise<string[]>>();
const TEAMS_TTL = 60 * 60 * 1000;

// El ml-service tiene dos espacios: "global" (5 ligas europeas) y "EC1".
// Todo código que no sea EC1 resuelve contra el modelo global. También se usa
// para POST /predict, cuyo validador solo acepta esos dos namespaces.
export function modelFor(league: string): string {
  return league === "EC1" ? "EC1" : "global";
}

export async function getModelTeams(league = "global"): Promise<string[]> {
  const model = modelFor(league);
  const hit = cache.get(model);
  if (hit && Date.now() - hit.cachedAt < TEAMS_TTL) return hit.teams;
  if (inflight.has(model)) return inflight.get(model)!;
  const pending = (async () => {
    try {
      const url = `${ML_URL}/teams${model === "global" ? "" : `?league=${encodeURIComponent(model)}`}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) throw new Error(`ml-service /teams (${model}): ${res.status}`);
      const data = (await res.json()) as { teams: string[] };
      cache.set(model, { teams: data.teams, cachedAt: Date.now() });
      return data.teams;
    } catch (err) {
      const cached = cache.get(model);
      if (cached) return cached.teams; // caché vencida como respaldo
      throw err;
    } finally {
      inflight.delete(model);
    }
  })();
  inflight.set(model, pending);
  return pending;
}

const OVERRIDES = TEAM_OVERRIDES;

function normalize(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function similarity(a: string, b: string): number {
  const at = new Set(a.split(" "));
  const bt = new Set(b.split(" "));
  if (at.size === 0 || bt.size === 0) return 0;
  const inter = new Set([...at].filter((t) => bt.has(t))).size;
  return inter / Math.min(at.size, bt.size);
}

function bestMatch(key: string, teams: string[]): string | null {
  let best: string | null = null;
  let bestScore = 0;
  for (const t of teams) {
    const score = similarity(key, normalize(t));
    if (score > bestScore) {
      bestScore = score;
      best = t;
    }
  }
  return bestScore >= 0.8 ? best : null;
}

export async function resolveTeam(displayName: string, league = "global"): Promise<string | null> {
  const key = normalize(displayName);
  const teams = await getModelTeams(league);

  const override = OVERRIDES[key];
  if (override) {
    if (teams.includes(override)) return override;
    return bestMatch(override, teams); // fallback fuzzy si el override no está en el modelo
  }

  return bestMatch(key, teams);
}
