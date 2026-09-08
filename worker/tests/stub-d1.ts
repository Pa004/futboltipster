// Stub en memoria de D1DatabaseLike. Despacha por prefijo de SQL para ejercitar
// el SQL real de D1Database (detecta desajustes de columnas/parámetros).
import type { D1DatabaseLike, D1Statement, D1Value, FixtureRow, TrackedRow } from "../src/db.js";

interface TrackedEntry extends TrackedRow {
  pick: string;
  outcome: string;
}

function norm(sql: string): string {
  return sql.trim().replace(/\s+/g, " ").toUpperCase();
}

export class StubStatement implements D1Statement {
  private values: D1Value[] = [];

  constructor(
    private stub: StubD1,
    private sql: string,
  ) {}

  bind(...values: D1Value[]): D1Statement {
    this.values = values;
    return this;
  }

  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.stub.query<T>(this.sql, this.values) };
  }

  async first<T>(): Promise<T | null> {
    const rows = this.stub.query<T>(this.sql, this.values);
    return rows.length > 0 ? rows[0] : null;
  }

  async run(): Promise<unknown> {
    this.stub.query(this.sql, this.values);
    return {};
  }
}

export class StubD1 implements D1DatabaseLike {
  fixtures = new Map<string, FixtureRow>();
  tracked = new Map<string, TrackedEntry>();
  meta = new Map<string, string>();
  rateLimits = new Map<string, { count: number; resetAt: number }>();

  prepare(query: string): D1Statement {
    return new StubStatement(this, query);
  }

  query<T>(sql: string, v: D1Value[]): T[] {
    const q = norm(sql);
    if (q.startsWith("SELECT 1")) return [];
    if (q.includes("AND STATUS='PRE' AND SKIP_REASON IS NULL")) return this.listPending(v) as T[];
    if (q.includes("FROM FIXTURES WHERE (? = '' OR LEAGUE = ?)")) return this.listFixtures(v) as T[];
    if (q.startsWith("INSERT INTO FIXTURES")) {
      this.upsertFixture(v);
      return [];
    }
    if (q.startsWith("SELECT CONFIDENCE, HIT FROM TRACKED")) return this.listTracked() as T[];
    if (q.includes("RESULT_CHECKED=0")) return this.listPendingResults() as T[];
    if (q.startsWith("INSERT INTO TRACKED")) {
      this.settleTracked(v);
      return [];
    }
    if (q.startsWith("UPDATE FIXTURES SET RESULT_CHECKED=1")) {
      this.markChecked(v);
      return [];
    }
    if (q.startsWith("SELECT VALUE FROM META")) return this.getMeta(v) as T[];
    if (q.startsWith("SELECT PREDICTION FROM FIXTURES")) return this.getFixturePrediction(v) as T[];
    if (q.startsWith("UPDATE FIXTURES SET HOME_MODEL")) {
      this.savePrediction(v);
      return [];
    }
    if (q.startsWith("UPDATE FIXTURES SET SKIP_REASON")) {
      this.setSkipReason(v);
      return [];
    }
    if (q.startsWith("INSERT INTO META")) {
      this.setMeta(v);
      return [];
    }
    if (q.startsWith("SELECT COUNT, RESET_AT FROM RATE_LIMITS")) return this.getRateLimit(v) as T[];
    if (q.startsWith("INSERT INTO RATE_LIMITS")) {
      this.resetRateLimit(v);
      return [];
    }
    if (q.startsWith("DELETE FROM RATE_LIMITS")) {
      this.purgeRateLimits(v);
      return [];
    }
    if (q.startsWith("UPDATE RATE_LIMITS SET COUNT")) {
      this.bumpRateLimit(v);
      return [];
    }
    throw new Error(`SQL no soportado por el stub: ${sql}`);
  }

  private listPending(v: D1Value[]): FixtureRow[] {
    const [league, , limit] = v as [string, string, number];
    return [...this.fixtures.values()]
      .filter((r) => (league === "" || r.league === league) && r.status === "pre" && r.skip_reason === null)
      .sort((a, b) => (a.date < b.date ? -1 : 1))
      .slice(0, limit);
  }

  private listFixtures(v: D1Value[]): FixtureRow[] {
    const [league, , today] = v as [string, string, string];
    return [...this.fixtures.values()]
      .filter((r) => (league === "" || r.league === league) && r.date >= (today as string))
      .sort((a, b) => (a.date < b.date ? -1 : 1))
      .slice(0, 100);
  }

  private upsertFixture(v: D1Value[]): void {
    const [id, league, date, home, away, homeShort, awayShort, homeLogo, awayLogo, status, homeScore, awayScore, skipReason] =
      v as [string, string, string, string, string, string, string, string | null, string | null, string, number | null, number | null, string | null];
    const existing = this.fixtures.get(id);
    if (existing) {
      existing.league = league;
      existing.date = date;
      existing.status = status;
      existing.home_score = homeScore;
      existing.away_score = awayScore;
      existing.home_logo = homeLogo;
      existing.away_logo = awayLogo;
      existing.skip_reason = skipReason;
      return;
    }
    this.fixtures.set(id, {
      id,
      league,
      date,
      home,
      away,
      home_short: homeShort,
      away_short: awayShort,
      status,
      home_score: homeScore,
      away_score: awayScore,
      home_model: null,
      away_model: null,
      predicted_at: null,
      prediction: null,
      skip_reason: skipReason,
      result_checked: 0,
      home_logo: homeLogo,
      away_logo: awayLogo,
    });
  }

  private getFixturePrediction(v: D1Value[]): { prediction: string | null }[] {
    const row = this.fixtures.get(v[0] as string);
    return row ? [{ prediction: row.prediction }] : [];
  }

  private savePrediction(v: D1Value[]): void {
    const row = this.fixtures.get(v[3] as string);
    if (!row) return;
    row.home_model = v[0] as string;
    row.away_model = v[1] as string;
    row.prediction = v[2] as string;
    row.skip_reason = null;
    row.predicted_at = new Date().toISOString();
  }

  private setSkipReason(v: D1Value[]): void {
    const row = this.fixtures.get(v[1] as string);
    if (row) row.skip_reason = v[0] as string;
  }

  private listTracked(): TrackedRow[] {
    return [...this.tracked.values()].map((t) => ({ confidence: t.confidence, hit: t.hit }));
  }

  private listPendingResults(): PendingResultRowLite[] {
    return [...this.fixtures.values()]
      .filter(
        (r) =>
          r.status === "post" &&
          r.result_checked === 0 &&
          r.prediction !== null &&
          r.home_score !== null &&
          r.away_score !== null,
      )
      .map((r) => ({ id: r.id, home_score: r.home_score as number, away_score: r.away_score as number, prediction: r.prediction as string }));
  }

  private settleTracked(v: D1Value[]): void {
    const [fixtureId, pick, confidence, outcome, hit] = v as [string, string, number, string, number];
    this.tracked.set(fixtureId, { pick, confidence, outcome, hit });
  }

  private markChecked(v: D1Value[]): void {
    const row = this.fixtures.get(v[0] as string);
    if (row) row.result_checked = 1;
  }

  private getMeta(v: D1Value[]): { value: string }[] {
    const value = this.meta.get(v[0] as string);
    return value === undefined ? [] : [{ value }];
  }

  private setMeta(v: D1Value[]): void {
    this.meta.set(v[0] as string, v[1] as string);
  }

  private getRateLimit(v: D1Value[]): { count: number; reset_at: number }[] {
    const entry = this.rateLimits.get(v[0] as string);
    return entry ? [{ count: entry.count, reset_at: entry.resetAt }] : [];
  }

  private resetRateLimit(v: D1Value[]): void {
    this.rateLimits.set(v[0] as string, { count: 1, resetAt: v[1] as number });
  }

  private purgeRateLimits(v: D1Value[]): void {
    for (const [k, e] of this.rateLimits) {
      if (e.resetAt < (v[0] as number)) this.rateLimits.delete(k);
    }
  }

  private bumpRateLimit(v: D1Value[]): void {
    const entry = this.rateLimits.get(v[1] as string);
    if (entry) entry.count = v[0] as number;
  }
}

interface PendingResultRowLite {
  id: string;
  home_score: number;
  away_score: number;
  prediction: string;
}
