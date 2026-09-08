// Capa de persistencia sobre D1. Define una interfaz Database mínima para que los
// tests inyecten un stub en memoria sin parsear SQL. Espejo del esquema de server/src/db.ts.
export type D1Value = string | number | boolean | null | ArrayBuffer;

export interface D1Statement {
  bind(...values: D1Value[]): D1Statement;
  all<T>(): Promise<{ results: T[] }>;
  first<T>(): Promise<T | null>;
  run(): Promise<unknown>;
}

export interface D1DatabaseLike {
  prepare(query: string): D1Statement;
}

export interface FixtureRow {
  id: string;
  league: string;
  date: string;
  home: string;
  away: string;
  home_short: string | null;
  away_short: string | null;
  status: string;
  home_score: number | null;
  away_score: number | null;
  home_model: string | null;
  away_model: string | null;
  predicted_at: string | null;
  prediction: string | null;
  skip_reason: string | null;
  result_checked: number;
  home_logo: string | null;
  away_logo: string | null;
}

export interface NewFixture {
  id: string;
  league: string;
  date: string;
  home: string;
  away: string;
  homeShort: string;
  awayShort: string;
  homeLogo: string | null;
  awayLogo: string | null;
  status: string;
  homeScore: number | null;
  awayScore: number | null;
  skipReason: string | null;
}

export interface TrackedRow {
  confidence: number;
  hit: number;
}

export interface PendingResultRow {
  id: string;
  home_score: number;
  away_score: number;
  prediction: string;
}

export interface Database {
  ping(): Promise<void>;
  listFixtures(league: string, today: string): Promise<FixtureRow[]>;
  listPending(league: string, limit: number): Promise<FixtureRow[]>;
  getFixturePrediction(id: string): Promise<string | null>;
  upsertFixture(fx: NewFixture): Promise<void>;
  savePrediction(id: string, homeModel: string, awayModel: string, prediction: string): Promise<void>;
  setSkipReason(id: string, reason: string): Promise<void>;
  listTracked(): Promise<TrackedRow[]>;
  listPendingResults(): Promise<PendingResultRow[]>;
  settleTracked(fixtureId: string, pick: string, confidence: number, outcome: string, hit: number): Promise<void>;
  markChecked(id: string): Promise<void>;
  getMeta(key: string): Promise<string | null>;
  setMeta(key: string, value: string): Promise<void>;
  hitRateLimit(key: string, limit: number, nowMs: number): Promise<boolean>;
}

const RATE_LIMIT_WINDOW_MS = 60_000;

export class D1Database implements Database {
  constructor(private db: D1DatabaseLike) {}

  async ping(): Promise<void> {
    await this.db.prepare("SELECT 1").all();
  }

  async listFixtures(league: string, today: string): Promise<FixtureRow[]> {
    const res = await this.db
      .prepare("SELECT * FROM fixtures WHERE (? = '' OR league = ?) AND date >= ? ORDER BY date LIMIT 100")
      .bind(league, league, today)
      .all<FixtureRow>();
    return res.results;
  }

  async upsertFixture(fx: NewFixture): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO fixtures
          (id, league, date, home, away, home_short, away_short, home_logo, away_logo, status, home_score, away_score, skip_reason)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          date=excluded.date, status=excluded.status,
          home_score=excluded.home_score, away_score=excluded.away_score,
          home_logo=excluded.home_logo, away_logo=excluded.away_logo,
          skip_reason=excluded.skip_reason`,
      )
      .bind(
        fx.id,
        fx.league,
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
        fx.skipReason,
      )
      .run();
  }

  async listPending(league: string, limit: number): Promise<FixtureRow[]> {
    const res = await this.db
      .prepare(
        "SELECT * FROM fixtures WHERE (? = '' OR league = ?) AND status='pre' AND skip_reason IS NULL ORDER BY date ASC LIMIT ?",
      )
      .bind(league, league, limit)
      .all<FixtureRow>();
    return res.results;
  }

  async getFixturePrediction(id: string): Promise<string | null> {
    const row = await this.db
      .prepare("SELECT prediction FROM fixtures WHERE id = ?")
      .bind(id)
      .first<{ prediction: string | null }>();
    return row?.prediction ?? null;
  }

  async savePrediction(id: string, homeModel: string, awayModel: string, prediction: string): Promise<void> {
    await this.db
      .prepare(
        "UPDATE fixtures SET home_model=?, away_model=?, prediction=?, skip_reason=NULL, predicted_at=datetime('now') WHERE id=?",
      )
      .bind(homeModel, awayModel, prediction, id)
      .run();
  }

  async setSkipReason(id: string, reason: string): Promise<void> {
    await this.db.prepare("UPDATE fixtures SET skip_reason=? WHERE id=?").bind(reason, id).run();
  }

  async listTracked(): Promise<TrackedRow[]> {
    const res = await this.db.prepare("SELECT confidence, hit FROM tracked").all<TrackedRow>();
    return res.results;
  }

  async listPendingResults(): Promise<PendingResultRow[]> {
    const res = await this.db
      .prepare(
        "SELECT id, home_score, away_score, prediction FROM fixtures WHERE status='post' AND result_checked=0 AND prediction IS NOT NULL AND home_score IS NOT NULL AND away_score IS NOT NULL",
      )
      .all<PendingResultRow>();
    return res.results;
  }

  async settleTracked(
    fixtureId: string,
    pick: string,
    confidence: number,
    outcome: string,
    hit: number,
  ): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO tracked (fixture_id, pick, confidence, outcome, hit, resolved_at)
        VALUES (?, ?, ?, ?, ?, datetime('now'))
        ON CONFLICT(fixture_id) DO UPDATE SET
          pick=excluded.pick, confidence=excluded.confidence,
          outcome=excluded.outcome, hit=excluded.hit, resolved_at=excluded.resolved_at`,
      )
      .bind(fixtureId, pick, confidence, outcome, hit)
      .run();
  }

  async markChecked(id: string): Promise<void> {
    await this.db.prepare("UPDATE fixtures SET result_checked=1 WHERE id=?").bind(id).run();
  }

  async getMeta(key: string): Promise<string | null> {
    const row = await this.db.prepare("SELECT value FROM meta WHERE key = ?").bind(key).first<{ value: string }>();
    return row?.value ?? null;
  }

  async setMeta(key: string, value: string): Promise<void> {
    await this.db
      .prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .bind(key, value)
      .run();
  }

  async hitRateLimit(key: string, limit: number, nowMs: number): Promise<boolean> {
    const row = await this.db
      .prepare("SELECT count, reset_at FROM rate_limits WHERE key = ?")
      .bind(key)
      .first<{ count: number; reset_at: number }>();
    if (!row || row.reset_at < nowMs) {
      await this.db
        .prepare(
          "INSERT INTO rate_limits (key, count, reset_at) VALUES (?, 1, ?) ON CONFLICT(key) DO UPDATE SET count=1, reset_at=excluded.reset_at",
        )
        .bind(key, nowMs + RATE_LIMIT_WINDOW_MS)
        .run();
      // Purga oportunista: la tabla solo crece con claves distintas por ventana.
      await this.db.prepare("DELETE FROM rate_limits WHERE reset_at < ?").bind(nowMs).run();
      return false;
    }
    const count = row.count + 1;
    await this.db.prepare("UPDATE rate_limits SET count = ? WHERE key = ?").bind(count, key).run();
    return count > limit;
  }
}
