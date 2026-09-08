import { LEAGUES, ML_URL } from "../config.js";
import { db } from "../db.js";
import { safeJson } from "../lib/json.js";
import { fetchLeagueFixtures } from "../providers/espn.js";
import { modelFor, resolveTeam } from "../teams.js";

function hasMarkets(prediction: string | null | undefined): boolean {
  const parsed = safeJson<{ markets?: unknown }>(prediction ?? "");
  return parsed?.markets !== undefined;
}

const META_TRAINED_AT = "ml_trained_at";

async function fetchModelTrainedAt(): Promise<string | null> {
  try {
    const res = await fetch(`${ML_URL}/health`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`ml-service /health: ${res.status}`);
    const data = (await res.json()) as { trained_at?: string | null };
    return data.trained_at ?? null;
  } catch {
    return null;
  }
}

function getMeta(key: string): string | null {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

function setMeta(key: string, value: string): void {
  db.prepare(
    "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
  ).run(key, value);
}

export async function predictFixture(home: string, away: string, league: string): Promise<object> {
  const res = await fetch(`${ML_URL}/predict`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ home, away, league }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`ml-service /predict ${res.status}: ${await res.text()}`);
  return (await res.json()) as object;
}

// Pool de workers con límite: el incremento de next++ es atómico porque no hay
// await entre el chequeo y la reserva del índice, así ningún worker repite tarea.
async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i]);
    }
  });
  await Promise.all(workers);
}

export async function refreshFixtures(force = false): Promise<{ processed: number; predicted: number }> {
  let processed = 0;
  const tasks: { id: string; home: string; away: string; league: string }[] = [];

  const entries = Object.entries(LEAGUES);
  const settled = await Promise.allSettled(entries.map(([, league]) => fetchLeagueFixtures(league.espn)));
  for (let i = 0; i < settled.length; i++) {
    const [code, league] = entries[i];
    const result = settled[i];
    if (result.status === "rejected") {
      console.error(`[sync] ${code} (${league.espn}) falló: ${(result.reason as Error).message}`);
      continue;
    }
    for (const fx of result.value) {
      const existing = db.prepare("SELECT home_model, prediction FROM fixtures WHERE id = ?").get(fx.id) as
        { home_model: string | null; prediction: string | null } | undefined;
      // Liga sin modelo: se guarda la razón para que el web explique el estado
      const skipReason = fx.status === "pre" && !league.model ? "no_model" : null;
      const upsert = db.prepare(`
        INSERT INTO fixtures
          (id, league, date, home, away, home_short, away_short, home_logo, away_logo, status, home_score, away_score, skip_reason)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          date=excluded.date, status=excluded.status,
          home_score=excluded.home_score, away_score=excluded.away_score,
          home_logo=excluded.home_logo, away_logo=excluded.away_logo,
          skip_reason=excluded.skip_reason
      `);
      upsert.run(
        fx.id,
        code,
        fx.date,
        fx.home,
        fx.away,
        fx.homeShort,
        fx.awayShort,
        fx.homeLogo,
        fx.awayLogo,
        fx.status,
        fx.homeScore,
        fx.awayScore,
        skipReason,
      );
      processed++;

      // force = modelo reentrenado: re-predice aunque la predicción ya tenga markets.
      // /predict solo acepta namespaces de modelo (global|EC1), no códigos de liga.
      if (fx.status === "pre" && league.model && (force || !hasMarkets(existing?.prediction))) {
        tasks.push({ id: fx.id, home: fx.home, away: fx.away, league: modelFor(code) });
      }
    }
  }

  let predicted = 0;
  await mapLimit(tasks, 5, async ({ id, home, away, league: code }) => {
    let homeModel: string | null;
    let awayModel: string | null;
    try {
      homeModel = await resolveTeam(home, code);
      awayModel = await resolveTeam(away, code);
    } catch (err) {
      // El ml-service no pudo resolver equipos (caído o sin caché); es distinto
      // de un fallo de predicción y se diagnostica con su propio skip_reason.
      db.prepare("UPDATE fixtures SET skip_reason='teams_unavailable' WHERE id=?").run(id);
      console.error(`[sync] equipos ${id} (${home} vs ${away}) no disponibles: ${(err as Error).message}`);
      return;
    }
    if (!homeModel || !awayModel) {
      // el modelo no tiene datos de alguno de los equipos; sin reintentos que lo arreglen
      db.prepare("UPDATE fixtures SET skip_reason='team_not_in_model' WHERE id=?").run(id);
      return;
    }
    try {
      const pred = await predictWithRetry(homeModel, awayModel, code);
      db.prepare(
        "UPDATE fixtures SET home_model=?, away_model=?, prediction=?, skip_reason=NULL, predicted_at=datetime('now') WHERE id=?",
      ).run(homeModel, awayModel, JSON.stringify(pred), id);
      predicted++;
    } catch (err) {
      db.prepare("UPDATE fixtures SET skip_reason='predict_failed' WHERE id=?").run(id);
      console.error(`[sync] prediccion ${id} (${home} vs ${away}) falló: ${(err as Error).message}`);
    }
  });

  const summary = db
    .prepare("SELECT skip_reason, COUNT(*) n FROM fixtures WHERE status='pre' GROUP BY skip_reason")
    .all() as { skip_reason: string | null; n: number }[];
  console.log(
    "[sync] estado prediccion:",
    summary.map((s) => `${s.skip_reason ?? "predicha"}=${s.n}`).join(", "),
  );

  return { processed, predicted };
}

// Un reintento inmediato absorbe latencias transitorias del ml-service sin bloquear el sync
async function predictWithRetry(home: string, away: string, league: string): Promise<object> {
  try {
    return await predictFixture(home, away, league);
  } catch {
    return predictFixture(home, away, league);
  }
}

let syncing = false;

export async function runSync(): Promise<{ processed: number; predicted: number; checked: number }> {
  if (syncing) return { processed: 0, predicted: 0, checked: 0 };
  syncing = true;
  try {
    const trainedAt = await fetchModelTrainedAt();
    // Si el modelo se reentrenó, las predicciones guardadas quedan obsoletas:
    // forzar re-predicción de todos los partidos pendientes.
    const force = trainedAt != null && trainedAt !== getMeta(META_TRAINED_AT);
    const { processed, predicted } = await refreshFixtures(force);
    if (trainedAt != null) setMeta(META_TRAINED_AT, trainedAt);
    const checked = checkResults();
    return { processed, predicted, checked };
  } finally {
    syncing = false;
  }
}

export function checkResults(): number {
  const pending = db
    .prepare(
      "SELECT * FROM fixtures WHERE status='post' AND result_checked=0 AND prediction IS NOT NULL AND home_score IS NOT NULL AND away_score IS NOT NULL",
    )
    .all() as {
    id: string;
    home_score: number;
    away_score: number;
    prediction: string;
  }[];

  let checked = 0;
  // ON CONFLICT re-asienta: si el modelo se reentrenó o ESPN corrige un marcador,
  // el historial se actualiza en vez de quedar congelado con INSERT OR IGNORE.
  const update = db.prepare(`
    INSERT INTO tracked (fixture_id, pick, confidence, outcome, hit, resolved_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(fixture_id) DO UPDATE SET
      pick=excluded.pick, confidence=excluded.confidence,
      outcome=excluded.outcome, hit=excluded.hit, resolved_at=excluded.resolved_at
  `);
  for (const fx of pending) {
    let pred: { pick: string; confidence: { probability: number } };
    try {
      pred = JSON.parse(fx.prediction) as { pick: string; confidence: { probability: number } };
    } catch {
      // fila corrupta: se marca como revisada para no reintentar infinitamente
      db.prepare("UPDATE fixtures SET result_checked=1 WHERE id=?").run(fx.id);
      continue;
    }
    const { pick, confidence } = pred;
    const validPick = pick === "H" || pick === "D" || pick === "A";
    const validConfidence =
      typeof confidence?.probability === "number" && Number.isFinite(confidence.probability);
    if (!validPick || !validConfidence) {
      // predicción malformada: no debe abortar el resto del chequeo
      db.prepare("UPDATE fixtures SET result_checked=1 WHERE id=?").run(fx.id);
      continue;
    }
    const outcome = fx.home_score > fx.away_score ? "H" : fx.home_score < fx.away_score ? "A" : "D";
    update.run(fx.id, pick, confidence.probability, outcome, pick === outcome ? 1 : 0);
    db.prepare("UPDATE fixtures SET result_checked=1 WHERE id=?").run(fx.id);
    checked++;
  }
  return checked;
}
