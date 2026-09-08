-- Esquema espejo de server/src/db.ts (incluye columnas de migraciones aplicadas).
CREATE TABLE IF NOT EXISTS fixtures (
  id TEXT PRIMARY KEY,
  league TEXT NOT NULL,
  date TEXT NOT NULL,
  home TEXT NOT NULL,
  away TEXT NOT NULL,
  home_short TEXT,
  away_short TEXT,
  status TEXT NOT NULL,
  home_score INTEGER,
  away_score INTEGER,
  home_model TEXT,
  away_model TEXT,
  predicted_at TEXT,
  prediction TEXT,
  skip_reason TEXT,
  result_checked INTEGER DEFAULT 0,
  home_logo TEXT,
  away_logo TEXT
);
CREATE INDEX IF NOT EXISTS idx_fixtures_league_date ON fixtures(league, date);
CREATE TABLE IF NOT EXISTS tracked (
  fixture_id TEXT PRIMARY KEY,
  pick TEXT NOT NULL,
  confidence REAL NOT NULL,
  outcome TEXT NOT NULL,
  hit INTEGER NOT NULL,
  resolved_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- Rate limit respaldado por D1 (los Workers no tienen estado local entre isolates).
CREATE TABLE IF NOT EXISTS rate_limits (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  reset_at INTEGER NOT NULL
);
