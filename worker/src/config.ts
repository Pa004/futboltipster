import type { D1DatabaseLike } from "./db.js";

// Entorno del Worker (bindings + vars). Los secrets (REFRESH_TOKEN) nunca van en wrangler.toml.
export interface AppEnv {
  DB: D1DatabaseLike;
  REFRESH_TOKEN?: string;
  CORS_ORIGINS?: string;
  TZ?: string;
  FOOTBALL_DATA_KEY?: string;
  CLOUD_TOKEN?: string;
}

export type LeagueSource = "football-data" | "ingest";

export interface LeagueInfo {
  espn: string;
  label: string;
  model: string | null;
  source: LeagueSource;
  fd: string | null;
}

// Única fuente de verdad de ligas (espejo de server/src/config.ts LEAGUES).
// Europa va por football-data.org (ESPN bloquea las IPs de Cloudflare con 403);
// EC1 no está cubierto por ningún proveedor gratuito y llega por relay local.
export const LEAGUES: Record<string, LeagueInfo> = {
  E0: { espn: "eng.1", label: "Premier League", model: "E0", source: "football-data", fd: "PL" },
  SP1: { espn: "esp.1", label: "La Liga", model: "SP1", source: "football-data", fd: "PD" },
  I1: { espn: "ita.1", label: "Serie A", model: "I1", source: "football-data", fd: "SA" },
  D1: { espn: "ger.1", label: "Bundesliga", model: "D1", source: "football-data", fd: "BL1" },
  F1: { espn: "fra.1", label: "Ligue 1", model: "F1", source: "football-data", fd: "FL1" },
  EC1: { espn: "ecu.1", label: "Liga Pro", model: "EC1", source: "ingest", fd: null },
};

export const DEFAULT_TZ = "America/Guayaquil";

// Presupuesto de predicciones por request (Fase 2: predicción lazy). En Fase 1 no se predice.
export const MAX_PREDICT_PER_REQUEST = 2;

export function timeZone(env: AppEnv): string {
  return env.TZ || DEFAULT_TZ;
}

export function refreshToken(env: AppEnv): string {
  return env.REFRESH_TOKEN ?? "";
}

export function footballDataKey(env: AppEnv): string {
  return env.FOOTBALL_DATA_KEY ?? "";
}

export function cloudToken(env: AppEnv): string {
  return env.CLOUD_TOKEN ?? "";
}

export function corsOrigins(env: AppEnv): string[] {
  return (env.CORS_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}
