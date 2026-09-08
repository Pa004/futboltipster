import { Hono } from "hono";
import { DEFAULT_BANDS } from "../bands.js";
import { LEAGUES, cloudToken, corsOrigins, footballDataKey, refreshToken, timeZone, type AppEnv } from "../config.js";
import { localToday } from "../dates.js";
import { D1Database, type FixtureRow } from "../db.js";
import { artifacts } from "../inference/artifacts.js";
import { safeJson } from "../lib/json.js";
import { hasMarkets, predictPending, runSync } from "../predict.js";

function tokensEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export const api = new Hono<{ Bindings: AppEnv }>();

// Pendiente = nunca intentado (sin skip determinista) y sin markets cacheados.
// Los skip_reason deterministas (no_model, team_not_in_model, teams_unavailable)
// no se reintentan en cada request.
function isPending(row: FixtureRow): boolean {
  return row.status === "pre" && row.skip_reason === null && !hasMarkets(row.prediction);
}

api.get("/leagues", (c) => {
  return c.json(
    Object.entries(LEAGUES).map(([code, l]) => ({
      code,
      label: l.label,
      hasModel: Boolean(l.model),
    })),
  );
});

api.get("/fixtures", async (c) => {
  const league = c.req.query("league") ?? "";
  const db = new D1Database(c.env.DB);
  // "Hoy" se calcula en la zona configurada (no UTC), igual que el server.
  let rows = await db.listFixtures(league, localToday(timeZone(c.env)));
  // Predicción lazy: completa lo pendiente dentro del presupuesto por request;
  // lo no alcanzado converge en siguientes auto-refresh (60s).
  const pending = rows.filter(isPending);
  if (pending.length > 0) {
    await predictPending(db, artifacts, pending);
    rows = await db.listFixtures(league, localToday(timeZone(c.env)));
  }
  return c.json(
    rows.map((r) => ({
      id: r.id,
      league: r.league,
      date: r.date,
      home: r.home,
      away: r.away,
      homeShort: r.home_short,
      awayShort: r.away_short,
      homeLogo: r.home_logo ?? null,
      awayLogo: r.away_logo ?? null,
      status: r.status,
      homeScore: r.home_score,
      awayScore: r.away_score,
      prediction: r.prediction ? safeJson<object>(r.prediction) : null,
      predictedAt: r.predicted_at,
      skipReason: r.skip_reason ?? null,
    })),
  );
});

api.get("/stats", async (c) => {
  const db = new D1Database(c.env.DB);
  const rows = await db.listTracked();
  const hits = rows.reduce((sum, r) => sum + r.hit, 0);
  const bands = DEFAULT_BANDS.map((b) => {
    const inBand = rows.filter((r) => r.confidence >= b.lo && r.confidence < b.hi);
    return {
      band: b.label,
      level: b.level,
      count: inBand.length,
      accuracy: inBand.length > 0 ? inBand.reduce((sum, r) => sum + r.hit, 0) / inBand.length : null,
    };
  });
  return c.json({
    totalTracked: rows.length,
    overallAccuracy: rows.length > 0 ? hits / rows.length : null,
    bands,
  });
});

const MAX_INGEST_BODY = 64 * 1024;
const MAX_INGEST_FIXTURES = 500;

interface IngestFixture {
  id: unknown;
  league: unknown;
  date: unknown;
  home: unknown;
  away: unknown;
  homeShort?: unknown;
  awayShort?: unknown;
  homeLogo?: unknown;
  awayLogo?: unknown;
  status: unknown;
  homeScore?: unknown;
  awayScore?: unknown;
}

function asString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function asNullableString(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  return typeof v === "string" ? v : null;
}

function asNullableScore(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

// Relay del server local (única vía de EC1 en cloud): upsert de fixtures con
// el shape del proveedor local. Misma semántica de skip_reason que refreshFixtures.
api.post("/ingest", async (c) => {
  const token = cloudToken(c.env);
  if (!token) return c.json({ error: "CLOUD_TOKEN no configurado" }, 503);
  const body = await c.req.text();
  if (body.length > MAX_INGEST_BODY) return c.json({ error: "cuerpo demasiado grande" }, 413);
  if (!tokensEqual(c.req.header("x-cloud-token") ?? "", token)) {
    return c.json({ error: "token inválido" }, 401);
  }
  const db = new D1Database(c.env.DB);
  const ip = c.req.header("CF-Connecting-IP") ?? "unknown";
  if ((await db.hitRateLimit(`ingest-ip:${ip}`, 10, Date.now())) || (await db.hitRateLimit(`ingest-token`, 30, Date.now()))) {
    return c.json({ error: "demasiadas solicitudes" }, 429);
  }
  let fixtures: unknown;
  try {
    fixtures = (JSON.parse(body) as { fixtures?: unknown }).fixtures;
  } catch {
    return c.json({ error: "JSON inválido" }, 400);
  }
  if (!Array.isArray(fixtures) || fixtures.length > MAX_INGEST_FIXTURES) {
    return c.json({ error: "fixtures inválidos" }, 400);
  }
  let upserted = 0;
  for (const raw of fixtures as IngestFixture[]) {
    const id = asString(raw.id);
    const league = LEAGUES[asString(raw.league) ?? ""];
    const date = asString(raw.date);
    const home = asString(raw.home);
    const away = asString(raw.away);
    const status = asString(raw.status);
    if (!id || !league || !date || !home || !away || !status) continue;
    await db.upsertFixture({
      id,
      league: asString(raw.league) as string,
      date,
      home,
      away,
      homeShort: asNullableString(raw.homeShort) ?? "",
      awayShort: asNullableString(raw.awayShort) ?? "",
      homeLogo: asNullableString(raw.homeLogo),
      awayLogo: asNullableString(raw.awayLogo),
      status,
      homeScore: asNullableScore(raw.homeScore),
      awayScore: asNullableScore(raw.awayScore),
      skipReason: status === "pre" && !league.model ? "no_model" : null,
    });
    upserted++;
  }
  return c.json({ received: fixtures.length, upserted });
});

api.post("/refresh", async (c) => {
  const token = refreshToken(c.env);
  if (!token) return c.json({ error: "REFRESH_TOKEN no configurado" }, 503);
  // Límite 1kb como el server (express.json({ limit: "1kb" })).
  const body = await c.req.text();
  if (body.length > 1024) return c.json({ error: "cuerpo demasiado grande" }, 413);
  if (!tokensEqual(c.req.header("x-refresh-token") ?? "", token)) {
    return c.json({ error: "token inválido" }, 401);
  }
  const db = new D1Database(c.env.DB);
  const ip = c.req.header("CF-Connecting-IP") ?? "unknown";
  if ((await db.hitRateLimit(`refresh-ip:${ip}`, 10, Date.now())) || (await db.hitRateLimit(`refresh-token`, 30, Date.now()))) {
    return c.json({ error: "demasiadas solicitudes" }, 429);
  }
  try {
    return c.json(await runSync(db, timeZone(c.env), artifacts, footballDataKey(c.env)));
  } catch (err) {
    console.error("[refresh]", (err as Error).message);
    return c.json({ error: "error de sincronización" }, 502);
  }
});

// Exportado para tests: orígenes permitidos según env (fail-closed si vacío).
export function isOriginAllowed(env: AppEnv, origin: string | undefined): boolean {
  if (!origin) return false;
  return corsOrigins(env).includes(origin);
}
