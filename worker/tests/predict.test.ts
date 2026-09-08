import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { D1Database } from "../src/db.js";
import { artifacts } from "../src/inference/artifacts.js";
import { refreshFixtures, runSync } from "../src/predict.js";
import { StubD1 } from "./stub-d1.js";

const TZ = "America/Guayaquil";
const KEY = "test-key";

function fdMatch(id: string | number, home: string, away: string): unknown {
  const team = (name: string) => ({
    id: 1,
    name,
    shortName: name,
    tla: name.slice(0, 3).toUpperCase(),
    crest: "http://x/y.png",
  });
  return {
    id,
    utcDate: "2999-01-01T20:00:00Z",
    status: "TIMED",
    homeTeam: team(home),
    awayTeam: team(away),
    score: { fullTime: { home: null, away: null } },
  };
}

// Un partido por llamada hasta agotar la lista; el resto responde vacío.
function mockFootballDataQueue(events: { id: string | number; home: string; away: string }[]): void {
  const queue = [...events];
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      const next = queue.shift();
      return new Response(JSON.stringify({ matches: next ? [fdMatch(next.id, next.home, next.away)] : [] }), {
        status: 200,
      });
    }),
  );
}

describe("refreshFixtures con inferencia", () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  it("upserta y predice dentro del presupuesto con envelope de /predict", async () => {
    mockFootballDataQueue([{ id: "fx-1", home: "Arsenal", away: "Chelsea" }]);
    const db = new D1Database(new StubD1());
    const result = await refreshFixtures(db, TZ, artifacts, false, KEY);
    expect(result).toEqual({ processed: 1, predicted: 1 });
    const stored = await db.getFixturePrediction("fdata-fx-1");
    expect(stored).not.toBeNull();
    const pred = JSON.parse(stored as string) as {
      home: string;
      away: string;
      league: string;
      pick: string;
      markets: { ft: unknown; corners: unknown };
    };
    expect(pred.home).toBe("Arsenal");
    expect(pred.away).toBe("Chelsea");
    expect(pred.league).toBe("E0");
    expect(["H", "D", "A"]).toContain(pred.pick);
    expect(pred.markets.ft).toBeDefined();
    expect(pred.markets.corners).toBeDefined();
  });

  it("acota a 2 predicciones por invocación", async () => {
    mockFootballDataQueue([
      { id: "fx-1", home: "Arsenal", away: "Chelsea" },
      { id: "fx-2", home: "Barcelona", away: "Arsenal" },
      { id: "fx-3", home: "Chelsea", away: "Barcelona" },
    ]);
    const db = new D1Database(new StubD1());
    const result = await refreshFixtures(db, TZ, artifacts, false, KEY);
    expect(result.processed).toBe(3);
    expect(result.predicted).toBe(2);
    expect(await db.getFixturePrediction("fdata-fx-3")).toBeNull();
  });

  it("marca team_not_in_model sin gastar inferencia", async () => {
    mockFootballDataQueue([{ id: "fx-9", home: "Equipo Inexistente ZZ", away: "Otro Inexistente YY" }]);
    const stub = new StubD1();
    const result = await refreshFixtures(new D1Database(stub), TZ, artifacts, false, KEY);
    expect(result).toEqual({ processed: 1, predicted: 0 });
    expect(stub.fixtures.get("fdata-fx-9")?.skip_reason).toBe("team_not_in_model");
  });

  it("force re-predice fixtures que ya tenían markets", async () => {
    const stub = new StubD1();
    const db = new D1Database(stub);
    stub.fixtures.set("fdata-fx-old", {
      id: "fdata-fx-old",
      league: "E0",
      date: "2999-01-01T20:00:00Z",
      home: "Arsenal",
      away: "Chelsea",
      home_short: "ARS",
      away_short: "CHE",
      status: "pre",
      home_score: null,
      away_score: null,
      home_model: "Arsenal",
      away_model: "Chelsea",
      predicted_at: "2026-01-01",
      prediction: JSON.stringify({ pick: "H", markets: { ft: {} } }),
      skip_reason: null,
      result_checked: 0,
      home_logo: null,
      away_logo: null,
    });
    mockFootballDataQueue([]);
    expect((await refreshFixtures(db, TZ, artifacts, false, KEY)).predicted).toBe(0);
    // La segunda llamada vuelve a consultar ESPN: se devuelve el fixture vía eng.1.
    mockFootballDataQueue([{ id: "fx-old", home: "Arsenal", away: "Chelsea" }]);
    expect((await refreshFixtures(db, TZ, artifacts, true, KEY)).predicted).toBe(1);
  });

  it("runSync persiste trained_at y no fuerza dos veces", async () => {
    mockFootballDataQueue([]);
    const db = new D1Database(new StubD1());
    const first = await runSync(db, TZ, artifacts, KEY);
    expect(first).toEqual({ processed: 0, predicted: 0, checked: 0 });
    expect(await db.getMeta("ml_trained_at")).toBe(artifacts.trainedAt);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ matches: [] }), { status: 200 })),
    );
    const second = await runSync(db, TZ, artifacts, KEY);
    expect(second.predicted).toBe(0);
  });
});
