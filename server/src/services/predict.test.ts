import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";

vi.mock("../providers/espn.js", () => ({
  fetchLeagueFixtures: vi.fn(),
}));
vi.mock("../teams.js", () => ({
  resolveTeam: vi.fn(),
  modelFor: (league: string) => (league === "EC1" ? "EC1" : "global"),
}));

import { fetchLeagueFixtures } from "../providers/espn.js";
import { resolveTeam } from "../teams.js";

const espnMock = vi.mocked(fetchLeagueFixtures);
const teamsMock = vi.mocked(resolveTeam);

let predict: typeof import("../services/predict.js");
let db: DatabaseSync;
let LEAGUES: { espn: string; label: string; model: string | null }[];

beforeAll(async () => {
  process.env.DB_PATH = ":memory:";
  predict = await import("../services/predict.js");
  ({ db } = await import("../db.js"));
  LEAGUES = Object.values((await import("../config.js")).LEAGUES);
});

afterEach(() => {
  espnMock.mockReset();
  teamsMock.mockReset();
  vi.unstubAllGlobals();
  db.prepare("DELETE FROM meta").run();
});

function seedFixture(overrides: Record<string, string | number | null> = {}) {
  db.prepare(
    `INSERT INTO fixtures (id, league, date, home, away, home_short, away_short, status, home_score, away_score, prediction, skip_reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    overrides.id ?? "fx-1",
    overrides.league ?? "E0",
    overrides.date ?? "2026-08-13T18:00Z",
    overrides.home ?? "Home",
    overrides.away ?? "Away",
    "HOM",
    "AWY",
    overrides.status ?? "pre",
    overrides.home_score ?? null,
    overrides.away_score ?? null,
    overrides.prediction ?? null,
    overrides.skip_reason ?? null,
  );
}

describe("checkResults", () => {
  it("ignora una prediction corrupta sin abortar el resto", () => {
    seedFixture({ status: "post", home_score: 1, away_score: 0, prediction: "not-json" });
    seedFixture({
      id: "fx-2",
      status: "post",
      home_score: 2,
      away_score: 1,
      prediction: JSON.stringify({ pick: "H", confidence: { probability: 0.7 } }),
    });

    expect(() => predict.checkResults()).not.toThrow();

    const corrupt = db.prepare("SELECT result_checked FROM fixtures WHERE id='fx-1'").get() as {
      result_checked: number;
    };
    expect(corrupt.result_checked).toBe(1);
    const tracked = db.prepare("SELECT COUNT(*) n FROM tracked").get() as { n: number };
    expect(tracked.n).toBe(1);
  });

  it("contabiliza el pick acertado", () => {
    seedFixture({
      id: "fx-3",
      status: "post",
      home_score: 3,
      away_score: 0,
      prediction: JSON.stringify({ pick: "H", confidence: { probability: 0.8 } }),
    });
    predict.checkResults();
    const row = db.prepare("SELECT pick, hit FROM tracked WHERE fixture_id='fx-3'").get() as {
      pick: string;
      hit: number;
    };
    expect(row.pick).toBe("H");
    expect(row.hit).toBe(1);
  });

  it("ignora un partido con away_score NULL", () => {
    seedFixture({
      id: "fx-4",
      status: "post",
      home_score: 2,
      away_score: null,
      prediction: JSON.stringify({ pick: "H", confidence: { probability: 0.6 } }),
    });
    expect(() => predict.checkResults()).not.toThrow();
    const row = db.prepare("SELECT result_checked FROM fixtures WHERE id='fx-4'").get() as {
      result_checked: number;
    };
    expect(row.result_checked).toBe(0);
  });
});

describe("runSync", () => {
  it("deduplica llamadas concurrentes con el mutex", async () => {
    let release: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let espnCalls = 0;
    espnMock.mockImplementation(async () => {
      espnCalls++;
      await gate;
      return [];
    });
    teamsMock.mockResolvedValue(null);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ status: "ok" }), { status: 200 })),
    );

    const first = predict.runSync();
    const second = predict.runSync();
    release!();
    const [r1, r2] = await Promise.all([first, second]);

    expect(r2).toEqual({ processed: 0, predicted: 0, checked: 0 });
    expect(espnCalls).toBe(LEAGUES.length);
    expect(r1.processed).toBeGreaterThanOrEqual(0);
  });

  it("re-predice al detectar un cambio de trained_at del modelo", async () => {
    seedFixture({
      id: "epl-5",
      status: "pre",
      prediction: JSON.stringify({ pick: "H", confidence: { probability: 0.7 }, markets: { ft: { home: 0.6 } } }),
    });
    espnMock.mockImplementation(async (espnLeague) => (espnLeague === "eng.1" ? [fixture("epl-5")] : []));
    teamsMock.mockResolvedValue("Man City");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).includes("/health")) {
          return new Response(JSON.stringify({ status: "ok", trained_at: "2026-08-14T00:00:00Z" }), {
            status: 200,
          });
        }
        return new Response(
          JSON.stringify({ pick: "D", confidence: { probability: 0.6 }, markets: { ft: { home: 0.4 } } }),
          { status: 200 },
        );
      }),
    );

    const result = await predict.runSync();
    expect(result.predicted).toBe(1);
    const row = db.prepare("SELECT prediction FROM fixtures WHERE id='epl-5'").get() as {
      prediction: string;
    };
    expect(JSON.parse(row.prediction).pick).toBe("D");
  });

  it("no fuerza re-predicción si trained_at no cambió", async () => {
    seedFixture({
      id: "epl-6",
      status: "pre",
      prediction: JSON.stringify({ pick: "H", confidence: { probability: 0.7 }, markets: { ft: { home: 0.6 } } }),
    });
    espnMock.mockImplementation(async (espnLeague) => (espnLeague === "eng.1" ? [fixture("epl-6")] : []));
    teamsMock.mockResolvedValue("Man City");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).includes("/health")) {
          return new Response(JSON.stringify({ status: "ok", trained_at: "2026-08-14T00:00:00Z" }), {
            status: 200,
          });
        }
        return new Response(
          JSON.stringify({ pick: "H", confidence: { probability: 0.7 }, markets: { ft: { home: 0.6 } } }),
          { status: 200 },
        );
      }),
    );

    const first = await predict.runSync(); // guarda trained_at en meta
    expect(first.predicted).toBe(1);
    const second = await predict.runSync(); // mismo trained_at: sin force
    expect(second.predicted).toBe(0);
  });
});

describe("refreshFixtures", () => {
  it("procesa las demás ligas si una falla", async () => {
    espnMock.mockImplementation(async (espnLeague) => {
      if (espnLeague === "ecu.1") throw new Error("ESPN 429");
      if (espnLeague === "eng.1") return [fixture("epl-1")];
      return [];
    });
    teamsMock.mockResolvedValue(null);

    const result = await predict.refreshFixtures();
    expect(result.processed).toBeGreaterThanOrEqual(1);
  });

  it("persiste la predicción cuando los equipos resuelven", async () => {
    espnMock.mockImplementation(async (espnLeague) => (espnLeague === "eng.1" ? [fixture("epl-2")] : []));
    teamsMock.mockResolvedValue("Man City");

    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ pick: "H", confidence: { level: "seguro", probability: 0.7 } }), {
            status: 200,
          }),
      ),
    );

    const result = await predict.refreshFixtures();
    expect(result.predicted).toBe(1);
    const row = db.prepare("SELECT prediction FROM fixtures WHERE id='epl-2'").get() as {
      prediction: string;
    };
    expect(JSON.parse(row.prediction).pick).toBe("H");
  });

  it("envía el namespace del modelo (global|EC1) a /predict, no el código de liga", async () => {
    espnMock.mockImplementation(async (espnLeague) =>
      espnLeague === "eng.1" ? [fixture("epl-9")] : espnLeague === "ecu.1" ? [fixture("ecu-9")] : [],
    );
    teamsMock.mockResolvedValue("Man City");

    const leagues: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: { body?: unknown }) => {
        leagues.push((JSON.parse(String(init?.body)) as { league: unknown }).league);
        return new Response(
          JSON.stringify({ pick: "H", confidence: { probability: 0.6 }, markets: { ft: {} } }),
          { status: 200 },
        );
      }),
    );

    const result = await predict.refreshFixtures();
    expect(result.predicted).toBe(2);
    // /predict valida league ∈ {global, EC1}: un código como "E0" devuelve 422.
    expect(leagues.sort()).toEqual(["EC1", "global"]);
  });

  it("persiste los escudos de ESPN en el fixture", async () => {
    espnMock.mockImplementation(async (espnLeague) => (espnLeague === "eng.1" ? [fixture("epl-shield")] : []));
    teamsMock.mockResolvedValue(null);

    await predict.refreshFixtures();
    const row = db.prepare("SELECT home_logo, away_logo FROM fixtures WHERE id='epl-shield'").get() as {
      home_logo: string | null;
      away_logo: string | null;
    };
    expect(row.home_logo).toBe("https://a.espncdn.com/i/team_logos/soccer/500/1000.png");
    expect(row.away_logo).toBe("https://a.espncdn.com/i/team_logos/soccer/500/1001.png");
  });

  it("re-predice una predicción en formato viejo (sin markets)", async () => {
    seedFixture({
      id: "epl-3",
      prediction: JSON.stringify({ pick: "H", confidence: { probability: 0.7 } }),
    });
    espnMock.mockImplementation(async (espnLeague) => (espnLeague === "eng.1" ? [fixture("epl-3")] : []));
    teamsMock.mockResolvedValue("Man City");

    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ pick: "D", confidence: { probability: 0.5 }, markets: { ft: { home: 0.3 } } }),
            { status: 200 },
          ),
      ),
    );

    const result = await predict.refreshFixtures();
    expect(result.predicted).toBe(1);
    const row = db.prepare("SELECT prediction FROM fixtures WHERE id='epl-3'").get() as {
      prediction: string;
    };
    expect(JSON.parse(row.prediction).markets).toBeDefined();
  });

  it("no re-predice una predicción que ya tiene markets", async () => {
    seedFixture({
      id: "epl-4",
      prediction: JSON.stringify({ pick: "H", confidence: { probability: 0.7 }, markets: { ft: { home: 0.6 } } }),
    });
    espnMock.mockImplementation(async (espnLeague) => (espnLeague === "eng.1" ? [fixture("epl-4")] : []));
    teamsMock.mockResolvedValue("Man City");

    const result = await predict.refreshFixtures();
    expect(result.predicted).toBe(0);
  });

  it("predice la liga EC1 ahora que tiene modelo", async () => {
    espnMock.mockImplementation(async (espnLeague) => (espnLeague === "ecu.1" ? [fixture("ecu-1")] : []));
    teamsMock.mockImplementation(async (_name, league) => (league === "EC1" ? "Barcelona SC" : null));

    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ pick: "H", confidence: { probability: 0.55 }, markets: { ft: {} } }),
            { status: 200 },
          ),
      ),
    );

    const result = await predict.refreshFixtures();
    expect(result.predicted).toBe(1);
    const row = db.prepare("SELECT prediction, skip_reason FROM fixtures WHERE id='ecu-1'").get() as {
      prediction: string | null;
      skip_reason: string | null;
    };
    expect(row.skip_reason).toBeNull();
    expect(row.prediction).toBeTruthy();
  });

  it("marca team_not_in_model cuando un equipo no resuelve", async () => {
    espnMock.mockImplementation(async (espnLeague) => (espnLeague === "eng.1" ? [fixture("epl-cup")] : []));
    teamsMock.mockResolvedValue(null);

    const result = await predict.refreshFixtures();
    expect(result.predicted).toBe(0);
    const row = db.prepare("SELECT skip_reason FROM fixtures WHERE id='epl-cup'").get() as {
      skip_reason: string | null;
    };
    expect(row.skip_reason).toBe("team_not_in_model");
  });

  it("marca predict_failed tras reintentar cuando el modelo falla", async () => {
    espnMock.mockImplementation(async (espnLeague) => (espnLeague === "eng.1" ? [fixture("epl-err")] : []));
    teamsMock.mockResolvedValue("Man City");
    let predictCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        predictCalls++;
        return new Response("boom", { status: 500 });
      }),
    );

    const result = await predict.refreshFixtures();
    expect(result.predicted).toBe(0);
    expect(predictCalls).toBe(2);
    const row = db.prepare("SELECT skip_reason FROM fixtures WHERE id='epl-err'").get() as {
      skip_reason: string | null;
    };
    expect(row.skip_reason).toBe("predict_failed");
  });

  it("marca teams_unavailable cuando resolver equipos falla y no hay caché", async () => {
    espnMock.mockImplementation(async (espnLeague) => (espnLeague === "eng.1" ? [fixture("epl-uteams")] : []));
    teamsMock.mockRejectedValue(new Error("ml-service /teams: 503"));

    const result = await predict.refreshFixtures();
    expect(result.predicted).toBe(0);
    const row = db.prepare("SELECT skip_reason FROM fixtures WHERE id='epl-uteams'").get() as {
      skip_reason: string | null;
    };
    expect(row.skip_reason).toBe("teams_unavailable");
  });

  it("borra skip_reason al conseguir la predicción", async () => {
    seedFixture({ id: "epl-ok", skip_reason: "predict_failed" });
    espnMock.mockImplementation(async (espnLeague) => (espnLeague === "eng.1" ? [fixture("epl-ok")] : []));
    teamsMock.mockResolvedValue("Man City");
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ pick: "H", confidence: { probability: 0.7 }, markets: { ft: {} } }), {
            status: 200,
          }),
      ),
    );

    const result = await predict.refreshFixtures();
    expect(result.predicted).toBe(1);
    const row = db.prepare("SELECT skip_reason, prediction FROM fixtures WHERE id='epl-ok'").get() as {
      skip_reason: string | null;
      prediction: string;
    };
    expect(row.skip_reason).toBeNull();
    expect(row.prediction).toBeTruthy();
  });
});

function fixture(id: string) {
  return {
    id,
    date: "2026-08-13T18:00Z",
    home: "Manchester City",
    away: "Arsenal",
    homeShort: "MCI",
    awayShort: "ARS",
    homeLogo: "https://a.espncdn.com/i/team_logos/soccer/500/1000.png",
    awayLogo: "https://a.espncdn.com/i/team_logos/soccer/500/1001.png",
    status: "pre",
    homeScore: null,
    awayScore: null,
  };
}
