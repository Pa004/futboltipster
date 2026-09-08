import { MAX_PREDICT_PER_REQUEST, LEAGUES } from "./config.js";
import type { Database } from "./db.js";
import { fetchLeagueFixtures } from "./footballData.js";
import { artifacts, selectModel, type Artifacts } from "./inference/artifacts.js";
import { buildPrediction } from "./inference/buildPrediction.js";
import { safeJson } from "./lib/json.js";
import { resolveTeam } from "./teams.js";

export interface SyncSummary {
  processed: number;
  predicted: number;
  checked: number;
}

const META_TRAINED_AT = "ml_trained_at";

export function hasMarkets(prediction: string | null | undefined): boolean {
  const parsed = safeJson<{ markets?: unknown }>(prediction ?? "");
  return parsed?.markets !== undefined;
}

interface PredictTask {
  id: string;
  home: string;
  away: string;
  league: string;
}

// Presupuesto por invocación: solo conteo. Date.now mide wall-time (incluye I/O
// de D1), no CPU, así que un guardia de tiempo abortaría por latencia de red y
// no por cómputo; 2 predicciones completas caben holgadamente en 10ms de CPU.
async function predictOne(db: Database, art: Artifacts, task: PredictTask): Promise<boolean> {
  const model = selectModel(art, task.league);
  if (model === null) {
    // Artefacto ausente (distinto de fallo de predicción: sin reintentos que lo arreglen).
    await db.setSkipReason(task.id, "teams_unavailable");
    return false;
  }
  const homeModel = resolveTeam(task.home, model.teams);
  const awayModel = resolveTeam(task.away, model.teams);
  if (!homeModel || !awayModel) {
    await db.setSkipReason(task.id, "team_not_in_model");
    return false;
  }
  try {
    const pred = buildPrediction(homeModel, awayModel, model, art);
    // Envelope idéntico al que guarda el server (respuesta de POST /predict).
    await db.savePrediction(task.id, homeModel, awayModel, JSON.stringify({ home: homeModel, away: awayModel, league: task.league, ...pred }));
    return true;
  } catch (err) {
    await db.setSkipReason(task.id, "predict_failed");
    console.error(`[sync] prediccion ${task.id} (${task.home} vs ${task.away}) falló: ${(err as Error).message}`);
    return false;
  }
}

export async function refreshFixtures(
  db: Database,
  timeZone: string,
  art: Artifacts = artifacts,
  force = false,
  apiKey = "",
): Promise<{ processed: number; predicted: number }> {
  // Fail-fast: sin key ni siquiera se intenta el sync (el 502 guía al operador).
  if (!apiKey) throw new Error("FOOTBALL_DATA_KEY no configurado");
  let processed = 0;
  const tasks: PredictTask[] = [];

  // Secuencial entre ligas: ~6 req/día frente a 10 req/min sin tope mensual.
  // Las ligas source=ingest (EC1) no se consultan: llegan por POST /api/ingest.
  for (const [code, league] of Object.entries(LEAGUES)) {
    if (league.source !== "football-data" || league.fd === null) continue;
    let fixtures;
    try {
      fixtures = await fetchLeagueFixtures(league.fd, timeZone, apiKey);
    } catch (err) {
      console.error(`[sync] ${code} (${league.fd}) falló: ${(err as Error).message}`);
      continue;
    }
    for (const fx of fixtures) {
      // Liga sin modelo: se guarda la razón para que el web explique el estado.
      const skipReason = fx.status === "pre" && !league.model ? "no_model" : null;
      await db.upsertFixture({
        id: fx.id,
        league: code,
        date: fx.date,
        home: fx.home,
        away: fx.away,
        homeShort: fx.homeShort,
        awayShort: fx.awayShort,
        homeLogo: fx.homeLogo,
        awayLogo: fx.awayLogo,
        status: fx.status,
        homeScore: fx.homeScore,
        awayScore: fx.awayScore,
        skipReason,
      });
      processed++;

      // force = artefactos reempaquetados: re-predice aunque ya tenga markets.
      if (fx.status === "pre" && league.model) {
        const existing = await db.getFixturePrediction(fx.id);
        if (force || !hasMarkets(existing)) tasks.push({ id: fx.id, home: fx.home, away: fx.away, league: code });
      }
    }
  }

  // Secuencial y acotado: cada invocación avanza lo que quepa en el presupuesto;
  // el resto converge en siguientes requests (auto-refresh 60s) o crons.
  let predicted = 0;
  for (const task of tasks.slice(0, MAX_PREDICT_PER_REQUEST)) {
    if (await predictOne(db, art, task)) predicted++;
  }
  return { processed, predicted };
}

// Sin flag syncing: cada invocación del Worker es aislada; la idempotencia la da el upsert.
export async function runSync(
  db: Database,
  timeZone: string,
  art: Artifacts = artifacts,
  apiKey = "",
): Promise<SyncSummary> {
  const trainedAt = art.trainedAt;
  // Si los artefactos cambiaron, las predicciones guardadas quedan obsoletas:
  // forzar re-predicción progresiva de los pendientes.
  const force = trainedAt != null && trainedAt !== (await db.getMeta(META_TRAINED_AT));
  const { processed, predicted } = await refreshFixtures(db, timeZone, art, force, apiKey);
  if (trainedAt != null) await db.setMeta(META_TRAINED_AT, trainedAt);
  const checked = await checkResults(db);
  return { processed, predicted, checked };
}

export interface PendingInput {
  id: string;
  home: string;
  away: string;
  league: string;
}

// Predice pendientes bajo demanda (llamado por GET /fixtures y por el cron).
// Devuelve cuántos se predijeron; lo no alcanzado queda para el siguiente request.
export async function predictPending(db: Database, art: Artifacts, rows: PendingInput[]): Promise<number> {
  let predicted = 0;
  for (const task of rows.slice(0, MAX_PREDICT_PER_REQUEST)) {
    if (await predictOne(db, art, task)) predicted++;
  }
  return predicted;
}

function outcomeOf(homeScore: number, awayScore: number): string {
  if (homeScore > awayScore) return "H";
  if (homeScore < awayScore) return "A";
  return "D";
}

async function settleRow(
  db: Database,
  fx: { id: string; home_score: number; away_score: number; prediction: string },
): Promise<boolean> {
  let pred: { pick: string; confidence: { probability: number } };
  try {
    pred = JSON.parse(fx.prediction) as { pick: string; confidence: { probability: number } };
  } catch {
    // Fila corrupta: se marca como revisada para no reintentar infinitamente.
    await db.markChecked(fx.id);
    return false;
  }
  const validPick = pred.pick === "H" || pred.pick === "D" || pred.pick === "A";
  const validConfidence =
    typeof pred.confidence?.probability === "number" && Number.isFinite(pred.confidence.probability);
  if (!validPick || !validConfidence) {
    // Predicción malformada: no debe abortar el resto del chequeo.
    await db.markChecked(fx.id);
    return false;
  }
  const outcome = outcomeOf(fx.home_score, fx.away_score);
  await db.settleTracked(fx.id, pred.pick, pred.confidence.probability, outcome, pred.pick === outcome ? 1 : 0);
  await db.markChecked(fx.id);
  return true;
}

export async function checkResults(db: Database): Promise<number> {
  const pending = await db.listPendingResults();
  let checked = 0;
  for (const fx of pending) {
    if (await settleRow(db, fx)) checked++;
  }
  return checked;
}
