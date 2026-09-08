import { Hono } from "hono";
import { corsOrigins, footballDataKey, timeZone, type AppEnv } from "./config.js";
import { D1Database } from "./db.js";
import { artifacts } from "./inference/artifacts.js";
import { hasMarkets, predictPending, runSync } from "./predict.js";
import { api } from "./routes/api.js";

export function createApp(): Hono<{ Bindings: AppEnv }> {
  const app = new Hono<{ Bindings: AppEnv }>();

  // Cabeceras de seguridad (espejo de server/src/index.ts, sin dependencias).
  app.use("*", async (c, next) => {
    await next();
    c.header("X-Content-Type-Options", "nosniff");
    c.header("X-Frame-Options", "DENY");
    c.header("Referrer-Policy", "no-referrer");
    c.header(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'",
    );
    c.header("Permissions-Policy", "camera=(), microphone=(), geolocation=(), interest-cohort=()");
    if (new URL(c.req.url).protocol === "https:") {
      c.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    }
  });

  // CORS fail-closed: sin CORS_ORIGINS explícito se niega todo origen cruzado.
  app.use("*", async (c, next) => {
    const origin = c.req.header("Origin");
    const allowed = origin !== undefined && corsOrigins(c.env).includes(origin);
    if (c.req.method === "OPTIONS") {
      const headers: Record<string, string> = {
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, x-refresh-token",
      };
      if (allowed && origin) headers["Access-Control-Allow-Origin"] = origin;
      return c.body(null, 204, headers);
    }
    await next();
    if (allowed && origin) c.header("Access-Control-Allow-Origin", origin);
  });

  app.get("/health", async (c) => {
    try {
      await new D1Database(c.env.DB).ping();
      return c.json({ status: "ok" });
    } catch {
      return c.json({ status: "error" }, 503);
    }
  });

  app.route("/api", api);

  app.notFound((c) => c.json({ error: "no encontrado" }, 404));
  app.onError((err, c) => {
    console.error("[error]", err instanceof Error ? err.stack : err);
    return c.json({ error: "error interno" }, 500);
  });

  return app;
}

const app = createApp();

interface ScheduleContext {
  waitUntil(promise: Promise<unknown>): void;
}

function scheduled(_event: unknown, env: AppEnv, ctx: ScheduleContext): void {
  ctx.waitUntil(
    (async () => {
      try {
        const db = new D1Database(env.DB);
        const result = await runSync(db, timeZone(env), artifacts, footballDataKey(env));
        // EC1 llega por /ingest (sin provider): también converge aquí.
        const pending = (await db.listPending("", 50)).filter((r) => !hasMarkets(r.prediction));
        const lazy = await predictPending(db, artifacts, pending);
        console.log(
          `[sync] processed=${result.processed} predicted=${result.predicted} checked=${result.checked} lazy=${lazy}`,
        );
      } catch (err) {
        console.error("[sync]", (err as Error).message);
      }
    })(),
  );
}

export default { fetch: app.fetch, scheduled };
