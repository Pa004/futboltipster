import { TEAM_OVERRIDES } from "./data/teamOverrides.js";

// Resolución displayName ESPN → nombre del modelo. Versión síncrona de
// server/src/teams.ts: los equipos vienen del JSON bundlado (sin fetch,
// sin caché TTL ni inflight). Espacios separados: EC1 vs global.
export function modelFor(leagueCode: string): "EC1" | "global" {
  return leagueCode === "EC1" ? "EC1" : "global";
}

export function normalize(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function similarity(a: string, b: string): number {
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

export function resolveTeam(displayName: string, teams: string[]): string | null {
  const key = normalize(displayName);
  const override = TEAM_OVERRIDES[key];
  if (override) {
    if (teams.includes(override)) return override;
    return bestMatch(override, teams); // fallback fuzzy si el override no está en el modelo
  }
  return bestMatch(key, teams);
}
