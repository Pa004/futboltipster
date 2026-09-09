import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";

let relay: typeof import("../services/cloudRelay.js");
let db: DatabaseSync;

beforeAll(async () => {
  process.env.DB_PATH = ":memory:";
  relay = await import("../services/cloudRelay.js");
  ({ db } = await import("../db.js"));
});

afterEach(() => {
  vi.unstubAllGlobals();
  db.prepare("DELETE FROM fixtures").run();
});

function seedEC1() {
  db.prepare(
    `INSERT INTO fixtures (id, league, date, home, away, home_short, away_short, status, home_score, away_score)
     VALUES ('ecu-1', 'EC1', '2999-01-01T20:00:00Z', 'Barcelona SC', 'Aucas', 'BSC', 'AUC', 'pre', NULL, NULL)`,
  ).run();
}

describe("pushCloudFixtures", () => {
  it("no hace nada sin url o token (relay desactivado)", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    seedEC1();
    await relay.pushCloudFixtures("", "");
    await relay.pushCloudFixtures("https://cloud.test", "");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("POSTea solo EC1 con el shape de /ingest", async () => {
    db.prepare(
      `INSERT INTO fixtures (id, league, date, home, away, home_short, away_short, status, home_score, away_score)
       VALUES ('epl-1', 'E0', '2999-01-01T20:00:00Z', 'Arsenal', 'Chelsea', 'ARS', 'CHE', 'pre', NULL, NULL)`,
    ).run();
    seedEC1();
    let url = "";
    let headers: Record<string, string> = {};
    let payload: { fixtures: { id: string; league: string }[] } = { fixtures: [] };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (u: string, init?: { headers?: Record<string, string>; body?: string }) => {
        url = String(u);
        headers = init?.headers ?? {};
        payload = JSON.parse(String(init?.body)) as typeof payload;
        return new Response(JSON.stringify({ received: 1, upserted: 1 }), { status: 200 });
      }),
    );
    await relay.pushCloudFixtures("https://cloud.test", "tok");
    expect(url).toBe("https://cloud.test/api/ingest");
    expect(headers["x-cloud-token"]).toBe("tok");
    // Solo EC1: E0 va por football-data.org en cloud (otros ids).
    expect(payload.fixtures.map((f) => f.id)).toEqual(["ecu-1"]);
    expect(payload.fixtures[0]).toMatchObject({ league: "EC1", home: "Barcelona SC" });
  });

  it("envía heartbeat aunque no haya filas (off-season)", async () => {
    let payload: { fixtures: unknown[] } = { fixtures: [] };
    let called = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_u: string, init?: { body?: string }) => {
        called = true;
        payload = JSON.parse(String(init?.body)) as typeof payload;
        return new Response(JSON.stringify({ received: 0, upserted: 0 }), { status: 200 });
      }),
    );
    await relay.pushCloudFixtures("https://cloud.test", "tok");
    expect(called).toBe(true);
    expect(payload.fixtures).toEqual([]);
  });

  it("no lanza si cloud falla", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("error", { status: 500 })),
    );
    seedEC1();
    await expect(relay.pushCloudFixtures("https://cloud.test", "tok")).resolves.toBeUndefined();
  });
});
