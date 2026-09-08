import "dotenv/config";
import cors from "cors";
import express from "express";
import cron from "node-cron";

import { CORS_ORIGINS, IS_PROD, ML_URL, PORT, SYNC_CRON, TRUST_PROXY } from "./config.js";
import { db } from "./db.js";
import { api } from "./routes/api.js";
import { pushCloudFixtures } from "./services/cloudRelay.js";
import { runSync } from "./services/predict.js";

const app = express();
app.disable("x-powered-by");

if (TRUST_PROXY) {
  // El deploy termina detrás de un proxy TLS; confiar un salto permite req.ip y req.secure reales
  app.set("trust proxy", 1);
}

// Cabeceras de seguridad (sin dependencias extra)
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'",
  );
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), interest-cohort=()");
  if (req.secure) {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
  next();
});

// CORS fail-closed: sin CORS_ORIGINS explícito se niega todo origen cruzado
app.use(cors({ origin: CORS_ORIGINS.length ? CORS_ORIGINS : false }));
app.use(express.json({ limit: "1kb" }));

app.get("/health", (_req, res) => {
  try {
    db.prepare("SELECT 1").get();
    res.json({ status: "ok" });
  } catch {
    res.status(503).json({ status: "error" });
  }
});

app.use("/api", api);

// Error middleware final: convierte cualquier error (incluidos rechazos de
// handlers async) en JSON en lugar del stack HTML por defecto de Express.
app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error("[error]", err instanceof Error ? err.stack : err);
  const detail = IS_PROD ? "error interno" : String(err);
  res.status(500).json({ error: detail });
});

async function waitForMl(retries = 24, delayMs = 5000): Promise<void> {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(`${ML_URL}/health`, { signal: AbortSignal.timeout(3000) });
      if (res.ok) return;
    } catch {
      // ml-service aún no responde; se reintenta
    }
    console.log(`[boot] esperando ml-service (intento ${i + 1}/${retries})...`);
    await new Promise((r) => setTimeout(r, delayMs));
  }
  console.error(`[boot] ml-service no respondió tras ${retries} intentos; se reintentará en el próximo cron`);
}

async function tick() {
  try {
    const { processed, predicted, checked } = await runSync();
    console.log(`[sync] processed=${processed} predicted=${predicted} checked=${checked}`);
    // Relay EC1 a cloud (best-effort; no bloquea ni rompe el sync local).
    await pushCloudFixtures();
  } catch (err) {
    console.error("[sync]", (err as Error).message);
  }
}

async function main() {
  app.listen(PORT, () => console.log(`FutbolTipster server en http://localhost:${PORT}`));
  cron.schedule(SYNC_CRON, tick);
  await waitForMl();
  await tick();
}

main().catch((err) => console.error("[boot]", (err as Error).message));
