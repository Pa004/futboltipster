import { describe, expect, it, vi } from "vitest";
import { fetchLeagueFixtures } from "../src/footballData.js";

const KEY = "test-key";

function envelope(matches: unknown[]): Response {
  return new Response(JSON.stringify({ matches }), { status: 200 });
}

function match(id: number, status: string, home = "Arsenal", away = "Chelsea"): unknown {
  const team = (name: string) => ({ id: 1, name, shortName: name, tla: name.slice(0, 3).toUpperCase(), crest: "http://x/y.png" });
  return {
    id,
    utcDate: "2999-01-01T20:00:00Z",
    status,
    homeTeam: team(home),
    awayTeam: team(away),
    score: { fullTime: { home: null, away: null } },
  };
}

describe("fetchLeagueFixtures (football-data.org)", () => {
  it("mapea TIMED→pre con shortName, tla y crest", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => envelope([match(1, "TIMED")])));
    try {
      const rows = await fetchLeagueFixtures("PL", "America/Guayaquil", KEY);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        id: "fdata-1",
        home: "Arsenal",
        away: "Chelsea",
        homeShort: "ARS",
        awayShort: "CHE",
        homeLogo: "http://x/y.png",
        status: "pre",
        homeScore: null,
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("mapea FINISHED→post con marcador e IN_PLAY→in", async () => {
    const finished = {
      id: 2,
      utcDate: "2026-09-01T20:00:00Z",
      status: "FINISHED",
      homeTeam: { id: 1, name: "Arsenal FC", shortName: "Arsenal", tla: "ARS", crest: "http://x/y.png" },
      awayTeam: { id: 2, name: "Chelsea FC", shortName: "Chelsea", tla: "CHE", crest: "http://x/z.png" },
      score: { fullTime: { home: 2, away: 1 } },
    };
    vi.stubGlobal("fetch", vi.fn(async () => envelope([finished, match(3, "IN_PLAY")])));
    try {
      const rows = await fetchLeagueFixtures("PL", "America/Guayaquil", KEY);
      expect(rows.map((r) => [r.id, r.status, r.homeScore, r.awayScore])).toEqual([
        ["fdata-2", "post", 2, 1],
        ["fdata-3", "in", null, null],
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("omite POSTPONED y lanza sin key o con error HTTP", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => envelope([match(4, "POSTPONED")])));
    try {
      expect(await fetchLeagueFixtures("PL", "America/Guayaquil", KEY)).toHaveLength(0);
    } finally {
      vi.unstubAllGlobals();
    }
    await expect(fetchLeagueFixtures("PL", "America/Guayaquil", "")).rejects.toThrow("FOOTBALL_DATA_KEY");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ message: "rate exceeded" }), { status: 429 })));
    try {
      await expect(fetchLeagueFixtures("PL", "America/Guayaquil", KEY)).rejects.toThrow("429");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("pide la ventana -2..+14 con token", async () => {
    const seen: string[] = [];
    const seenKey: (string | null)[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: { headers?: Record<string, string> }) => {
        seen.push(String(url));
        seenKey.push(init?.headers?.["X-Auth-Token"] ?? null);
        return envelope([]);
      }),
    );
    try {
      await fetchLeagueFixtures("PD", "America/Guayaquil", KEY);
    } finally {
      vi.unstubAllGlobals();
    }
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain("/competitions/PD/matches?");
    expect(seen[0]).toMatch(/dateFrom=\d{4}-\d{2}-\d{2}&dateTo=\d{4}-\d{2}-\d{2}/);
    expect(seenKey).toEqual([KEY]);
  });
});
