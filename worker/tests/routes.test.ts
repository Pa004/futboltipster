import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../src/config.js";
import type { FixtureRow } from "../src/db.js";
import { createApp } from "../src/index.js";
import { StubD1 } from "./stub-d1.js";

const TOKEN = "test-token";
const CLOUD_TOKEN = "cloud-token";

function makeEnv(stub: StubD1, overrides: Partial<AppEnv> = {}): AppEnv {
  return {
    DB: stub,
    REFRESH_TOKEN: TOKEN,
    CORS_ORIGINS: "",
    TZ: "America/Guayaquil",
    FOOTBALL_DATA_KEY: "test-key",
    CLOUD_TOKEN,
    ...overrides,
  };
}

function fixtureRow(partial: Partial<FixtureRow> & { id: string }): FixtureRow {
  return {
    league: "E0",
    date: "2999-01-01T20:00:00Z",
    home: "Arsenal",
    away: "Chelsea",
    home_short: "ARS",
    away_short: "CHE",
    status: "pre",
    home_score: null,
    away_score: null,
    home_model: null,
    away_model: null,
    predicted_at: null,
    prediction: null,
    skip_reason: null,
    result_checked: 0,
    home_logo: null,
    away_logo: null,
    ...partial,
  };
}

function mockEmptyEspn(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ matches: [] }), { status: 200 })),
  );
}

describe("GET /api/leagues", () => {
  it("devuelve las 6 ligas con el shape del web", async () => {
    const res = await createApp().request("/api/leagues", {}, makeEnv(new StubD1()));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { code: string; label: string; hasModel: boolean }[];
    expect(body).toHaveLength(6);
    expect(body.map((l) => l.code)).toEqual(["E0", "SP1", "I1", "D1", "F1", "EC1"]);
    expect(body.every((l) => typeof l.label === "string" && typeof l.hasModel === "boolean")).toBe(true);
  });
});

describe("GET /api/fixtures", () => {
  it("mapea filas D1 al shape del web y filtra por liga", async () => {
    const stub = new StubD1();
    // Con markets ya cacheados no dispara la predicción lazy.
    stub.fixtures.set("1", fixtureRow({ id: "1", league: "E0", prediction: JSON.stringify({ pick: "H", markets: { ft: {} } }) }));
    stub.fixtures.set("2", fixtureRow({ id: "2", league: "SP1", skip_reason: "no_model" }));
    const app = createApp();
    const res = await app.request("/api/fixtures?league=E0", {}, makeEnv(stub));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>[];
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({
      id: "1",
      league: "E0",
      home: "Arsenal",
      homeShort: "ARS",
      homeLogo: null,
      status: "pre",
      homeScore: null,
      prediction: { pick: "H", markets: { ft: {} } },
      predictedAt: null,
      skipReason: null,
    });
  });

  it("predicción lazy: completa pendientes reales dentro del presupuesto", async () => {
    const stub = new StubD1();
    stub.fixtures.set("1", fixtureRow({ id: "1", league: "E0", home: "Arsenal", away: "Chelsea" }));
    stub.fixtures.set("2", fixtureRow({ id: "2", league: "E0", home: "Barcelona", away: "Arsenal" }));
    stub.fixtures.set("3", fixtureRow({ id: "3", league: "E0", home: "Chelsea", away: "Barcelona" }));
    const res = await createApp().request("/api/fixtures?league=E0", {}, makeEnv(stub));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; prediction: { markets?: unknown } | null }[];
    const withMarkets = body.filter((f) => f.prediction?.markets !== undefined);
    // Presupuesto: 2 por request; el tercero converge en el siguiente.
    expect(withMarkets).toHaveLength(2);
    const res2 = await createApp().request("/api/fixtures?league=E0", {}, makeEnv(stub));
    const body2 = (await res2.json()) as { id: string; prediction: { markets?: unknown } | null }[];
    expect(body2.filter((f) => f.prediction?.markets !== undefined)).toHaveLength(3);
  });
});

describe("GET /api/stats", () => {
  it("sin tracked devuelve ceros y bandas default", async () => {
    const res = await createApp().request("/api/stats", {}, makeEnv(new StubD1()));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      totalTracked: number;
      overallAccuracy: number | null;
      bands: { band: string; level: string; count: number; accuracy: number | null }[];
      lastRelayAt: string | null;
    };
    expect(body.totalTracked).toBe(0);
    expect(body.overallAccuracy).toBeNull();
    expect(body.lastRelayAt).toBeNull();
    expect(body.bands).toHaveLength(4);
    expect(body.bands[0]).toMatchObject({ band: "Seguro", level: "seguro", count: 0, accuracy: null });
  });

  it("agrega aciertos por banda", async () => {
    const stub = new StubD1();
    stub.tracked.set("a", { pick: "H", confidence: 0.7, outcome: "H", hit: 1 });
    stub.tracked.set("b", { pick: "A", confidence: 0.6, outcome: "H", hit: 0 });
    const res = await createApp().request("/api/stats", {}, makeEnv(stub));
    const body = (await res.json()) as {
      totalTracked: number;
      overallAccuracy: number;
      bands: { level: string; count: number; accuracy: number | null }[];
    };
    expect(body.totalTracked).toBe(2);
    expect(body.overallAccuracy).toBe(0.5);
    expect(body.bands.find((b) => b.level === "seguro")).toMatchObject({ count: 1, accuracy: 1 });
    expect(body.bands.find((b) => b.level === "probable")).toMatchObject({ count: 1, accuracy: 0 });
  });
});

  it("fija Cache-Control de 60s en los GET", async () => {
    const app = createApp();
    const env = makeEnv(new StubD1());
    for (const path of ["/api/leagues", "/api/fixtures", "/api/stats"]) {
      const res = await app.request(path, {}, env);
      expect(res.status).toBe(200);
      expect(res.headers.get("Cache-Control")).toBe("public, max-age=60");
    }
  });

describe("POST /api/refresh", () => {
  beforeEach(() => mockEmptyEspn());
  afterEach(() => vi.unstubAllGlobals());

  it("503 sin REFRESH_TOKEN configurado", async () => {
    const res = await createApp().request(
      "/api/refresh",
      { method: "POST", headers: { "x-refresh-token": TOKEN } },
      makeEnv(new StubD1(), { REFRESH_TOKEN: "" }),
    );
    expect(res.status).toBe(503);
  });

  it("502 sin FOOTBALL_DATA_KEY configurado", async () => {
    const res = await createApp().request(
      "/api/refresh",
      { method: "POST", headers: { "x-refresh-token": TOKEN } },
      makeEnv(new StubD1(), { FOOTBALL_DATA_KEY: "" }),
    );
    expect(res.status).toBe(502);
  });

  it("401 con token inválido", async () => {
    const res = await createApp().request(
      "/api/refresh",
      { method: "POST", headers: { "x-refresh-token": "otro" } },
      makeEnv(new StubD1()),
    );
    expect(res.status).toBe(401);
  });

  it("200 con resumen del sync y asienta resultados pendientes", async () => {
    const stub = new StubD1();
    stub.fixtures.set(
      "p1",
      fixtureRow({
        id: "p1",
        status: "post",
        home_score: 2,
        away_score: 1,
        prediction: JSON.stringify({ pick: "H", confidence: { probability: 0.6 } }),
      }),
    );
    const res = await createApp().request(
      "/api/refresh",
      { method: "POST", headers: { "x-refresh-token": TOKEN } },
      makeEnv(stub),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ processed: 0, predicted: 0, checked: 1 });
    expect(stub.tracked.get("p1")).toMatchObject({ pick: "H", confidence: 0.6, outcome: "H", hit: 1 });
  });

  it("429 tras exceder 10 solicitudes por minuto", async () => {
    const app = createApp();
    const env = makeEnv(new StubD1());
    let lastStatus = 0;
    for (let i = 0; i < 11; i++) {
      const res = await app.request(
        "/api/refresh",
        { method: "POST", headers: { "x-refresh-token": TOKEN } },
        env,
      );
      lastStatus = res.status;
    }
    expect(lastStatus).toBe(429);
  });
});

describe("POST /api/ingest", () => {
  const row = {
    id: "ecu-1",
    league: "EC1",
    date: "2999-01-01T20:00:00Z",
    home: "Barcelona SC",
    away: "Aucas",
    homeShort: "BSC",
    awayShort: "AUC",
    homeLogo: null,
    awayLogo: null,
    status: "pre",
    homeScore: null,
    awayScore: null,
  };

  it("503 sin CLOUD_TOKEN configurado", async () => {
    const res = await createApp().request(
      "/api/ingest",
      { method: "POST", headers: { "x-cloud-token": CLOUD_TOKEN }, body: JSON.stringify({ fixtures: [] }) },
      makeEnv(new StubD1(), { CLOUD_TOKEN: "" }),
    );
    expect(res.status).toBe(503);
  });

  it("401 con token inválido y 400 con JSON inválido", async () => {
    const app = createApp();
    const env = makeEnv(new StubD1());
    const badToken = await app.request(
      "/api/ingest",
      { method: "POST", headers: { "x-cloud-token": "otro" }, body: "{}" },
      env,
    );
    expect(badToken.status).toBe(401);
    const badJson = await app.request(
      "/api/ingest",
      { method: "POST", headers: { "x-cloud-token": CLOUD_TOKEN }, body: "no-json" },
      env,
    );
    expect(badJson.status).toBe(400);
  });

  it("upserta fixtures EC1 y omite filas inválidas", async () => {
    const stub = new StubD1();
    const res = await createApp().request(
      "/api/ingest",
      {
        method: "POST",
        headers: { "x-cloud-token": CLOUD_TOKEN },
        body: JSON.stringify({ fixtures: [row, { id: "", league: "EC1" }] }),
      },
      makeEnv(stub),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: 2, upserted: 1 });
    expect(stub.fixtures.get("ecu-1")).toMatchObject({ league: "EC1", home: "Barcelona SC", skip_reason: null });
    expect(stub.meta.get("last_relay_at")).not.toBeNull();
  });
});

describe("cabeceras y CORS", () => {
  it("fija cabeceras de seguridad y niega origen cruzado por defecto", async () => {
    const res = await createApp().request(
      "/api/leagues",
      { headers: { Origin: "https://ejemplo.com" } },
      makeEnv(new StubD1()),
    );
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("permite el origen configurado", async () => {
    const res = await createApp().request(
      "/api/leagues",
      { headers: { Origin: "https://app.pages.dev" } },
      makeEnv(new StubD1(), { CORS_ORIGINS: "https://app.pages.dev" }),
    );
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://app.pages.dev");
    expect(res.headers.get("Vary")).toBe("Origin");
  });
});

describe("GET /health", () => {
  it("responde ok con D1 disponible", async () => {
    const res = await createApp().request("/health", {}, makeEnv(new StubD1()));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });
});
