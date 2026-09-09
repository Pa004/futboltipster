# FutbolTipster

Statistical football predictions (1X2 and derived markets) powered by Dixon-Coles and Negative-Binomial models, presented with confidence bands. **Informative, not betting advice.**

**Live demo:** https://futboltipster.pages.dev — API: https://futboltipster-worker.pablodo004.workers.dev/health

![FutbolTipster — match list](docs/screenshots/app.png)

## What it is

A full-stack project that predicts football match outcomes from a statistical engine and shows them in a responsive web app:

- **6 leagues**: 5 European (Premier League, La Liga, Serie A, Bundesliga, Ligue 1) + the Ecuadorian Liga Pro (EC1)
- **~20 derived markets** per match: double chance, over/under, Asian handicap, HT and HT/FT, corners, bookings, shots on target, fouls, first goal/corner
- **Confidence bands** on every prediction (Safe, Likely, Tight, Uncertain) so you know how much to trust each pick
- **Two model families**: Dixon-Coles (bivariate Poisson for full-time and first-half scores) and Negative-Binomial for count markets, trained on 2014–2025 results with temporal decay and recent form (k=5)

![FutbolTipster — expanded match with markets](docs/screenshots/app-detail.png)

## How it works

```
ESPN (live fixtures)  →  server (Node/Express + SQLite)  →  ml-service (FastAPI models)  →  web (React)
```

The server syncs fixtures from ESPN on a cron schedule, resolves team names against the models, asks the ml-service for predictions, and persists everything in SQLite. The web app reads from `/api` — nothing else.

## Tech stack

| Service | Stack | Role |
|---------|-------|------|
| `ml-service` | Python / FastAPI | Statistical models and markets (`/predict`, `/teams`, `/health`) |
| `server` | Node / Express + SQLite | ESPN orchestration, team resolution, predictions, tracking |
| `web` | React 19 / Vite / Tailwind v4 | Responsive SPA that only reads `/api` |

## Architecture

```
ESPN scoreboard (fixtures, -2..+14 days)
   │  cron sync (SYNC_CRON, 06:00 local · TZ)
   ▼
server  Node/Express + SQLite  (:4000)
   │  runSync → refreshFixtures → resolveTeam → predictFixture → persist
   │  POST /predict
   ▼
ml-service  FastAPI  (:8001)
   │  models loaded from artifacts/*.npz
   │  (Dixon-Coles FT & HT, HT/FT conditional, Negative-Binomial counts)
   ▼
web  React 19 + Vite  (:5173)
   │  reads /api only (Vite proxy in dev)
```

Key design points:

- **One shared model for the 5 European leagues**; Liga Pro (EC1) uses its own Dixon-Coles trained on ESPN history — EC1 data never touches the global model.
- **Artifacts are reproducible**: `ml-service/data/` and `ml-service/artifacts/` are gitignored and regenerated with the download scripts + `scripts/train.py`.
- **Confidence bands have a single source of truth**: the ml-service serves `GET /bands` and the server caches it with a fallback.
- **Auto re-prediction**: if the model is retrained (`trained_at` changes), the server force-repredicts pending fixtures.

### Repository structure

```
ml-service/              # Python / FastAPI — statistical models
  app/
    api.py               # /predict, /teams, /health, /models, /bands
    data.py              # loads historical CSVs (5 European leagues + EC1)
    models/
      dixon_coles.py     # Dixon-Coles for FT and HT scores
      count_model.py     # Negative-Binomial for count markets (recent form, k=5)
      markets.py         # ~20 derived markets
  scripts/               # download_data, download_espn_ecuador, train, validate, backtest,
                       # export_to_json (Worker artifacts), generate_golden (TS parity vectors)
  tests/                 # pytest (38 tests)
  requirements.lock      # pinned Python dependencies

server/                  # Node / Express + SQLite — orchestration
  src/
    index.ts             # bootstrap, cron sync, health-check of ml-service
    config.ts            # env: PORT, ML_URL, SYNC_CRON, DB_PATH, REFRESH_TOKEN, CORS, CLOUD_SYNC_*
    db.ts                # node:sqlite — fixtures, picks, stats, meta
    teams.ts             # resolves ESPN display names → model team names (fuzzy ≥ 0.8)
    dates.ts             # local dates (TZ) for the fixture window and filter
    providers/espn.ts    # ESPN scoreboard client
    routes/api.ts        # /api/leagues, /api/fixtures, /api/stats, /api/refresh, /api/ingest
    services/predict.ts  # runSync, re-prediction by trained_at, backfill
    services/cloudRelay.ts  # pushes EC1 fixtures to the cloud Worker (best-effort)
    data/teamOverrides.ts   # ESPN → model aliases (single source)
    lib/json.ts          # safe JSON response helpers
  package.json

worker/                  # Cloudflare Worker + D1 — cloud port (free tier)
  src/
    index.ts             # fetch + scheduled handlers, security headers, fail-closed CORS
    routes/api.ts        # same /api contracts as the server (+ Cache-Control: max-age=60)
    db.ts                # D1 wrapper (same schema as server) + D1-backed rate limit
    predict.ts           # lazy prediction (max 2 per request) + checkResults
    footballData.ts      # football-data.org fixtures client (Europe)
    teams.ts · dates.ts · bands.ts · config.ts  # pure logic mirrored from server/
    inference/           # TypeScript ports: dixonColes, countModel, markets,
                         # artifacts (JSON), buildPrediction
  data/*.json            # gitignored; regenerate with ml-service/scripts/export_to_json.py
  migrations/0001_init.sql  # D1 schema
  tests/                 # vitest (40 tests: routes, predict, parity vs golden vectors)
  wrangler.toml          # D1 binding, 06:00 GYE cron, vars (secrets via wrangler secret put)
  package.json           # test:ci runs the subset that needs no artifacts (CI)


web/                     # React 19 / Vite / Tailwind v4 — frontend
  src/
    App.tsx              # league tabs, silent auto-refresh every 60s
    api.ts · bands.ts · heat.ts · utils.ts
    components/          # MatchCard, Markets, ProbabilityBar, ConfidenceBadge, BandLegend,
                         #   Countdown, MatchToolbar, SpotlightCard, Sidebar, Header,
                         #   ThemeToggle, Tooltip, ErrorBoundary
    components/ui/       # shadcn/ui primitives: badge, button, select, dropdown-menu, tooltip
    hooks/useTheme.ts    # light/dark theme
  e2e/                   # smoke (7 checks) + responsive (51 checks) via playwright-core
  scripts/               # verify-* checks and screenshot helper
  package.json
```

### Key packages

**ml-service** (Python)

| Package | Purpose |
|---------|---------|
| fastapi + uvicorn | API server |
| numpy · scipy · pandas | model math and data |
| pydantic | request/response validation |
| pytest · httpx | tests (httpx is required by FastAPI's TestClient) |

**server** (Node)

| Package | Purpose |
|---------|---------|
| express | HTTP API |
| node-cron | sync schedule |
| cors · dotenv | middleware and env |
| `node:sqlite` (built-in) | persistence |
| dev: tsx · typescript · vitest · eslint · prettier | running and tooling |

**web** (React)

| Package | Purpose |
|---------|---------|
| react · react-dom | UI |
| @base-ui/react + shadcn/ui | accessible primitives |
| lucide-react | icons |
| motion | animations |
| tailwindcss v4 (@tailwindcss/vite) | styling |
| dev: vite · vitest · testing-library · playwright-core · shadcn | build, tests, e2e |

### Testing & CI

```bash
# ml-service (Python)
cd ml-service && python -m ruff check app tests scripts && python -m ruff format --check . && python -m pytest tests -q   # 38 tests

# server (Node)
cd server && npm run lint && npm test && npm run typecheck                                                            # 27 tests

# web (React)
cd web && npm run lint && npm test && npm run typecheck                                                               # 28 tests

# worker (Cloudflare; needs worker/data/*.json — see below)
cd worker && npm run lint && npm test && npm run typecheck                                                             # 40 tests

# e2e (requires the three local services running)
cd web && npm run test:e2e && npm run test:e2e:responsive                                                              # 7 + 51 checks
```

GitHub Actions (`.github/workflows/ci.yml`) runs lint, typecheck, tests and `pip-audit`/`npm audit` for all four services on every push. The worker job runs the subset that needs no artifacts (`test:ci`); parity/predict/routes need the real JSON and run locally.

## Getting started

```bash
# ml-service (models)
cd ml-service
pip install -r requirements.lock
uvicorn app.api:app --port 8001

# server (Express + SQLite + ESPN)
cd server
cp ../.env.example .env
npm install && npm run dev

# web (frontend)
cd web
npm install && npm run dev   # http://localhost:5173
```

Worker tests need the artifacts JSON first (gitignored, like the `.npz`):

```bash
cd ml-service && python scripts/export_to_json.py   # regenerates worker/data/*.json
```

Environment variables are documented in `.env.example`; API endpoints and the data/training pipeline are documented in the source of each service (`server/`, `ml-service/`, `web/`, `worker/`).

## Validation & honesty

Models are validated walk-forward on out-of-sample seasons (2023–2025, n≈5.4k): log-loss ≈ 0.99, RPS ≈ 0.20, ~52% accuracy for the FT model. A flat-betting backtest of all 14 markets with synthetic SBOBET-style odds shows **no market beats the 7% bookmaker margin** — derived markets are informative, not a betting system.

## Roadmap

- **Band-level recalibration** (deferred): only if the project is monetized.
- **Player-level markets** (deferred): needs a scorer-per-match data source.

## Deploy (Cloudflare, free tier)

`worker/` is a Cloudflare port of `server/` plus the ml-service inference, designed for the Workers Free plan ($0, no card required):

| Local | Cloud |
|-------|-------|
| Express (`server/`) | Hono Worker (`worker/src`) |
| `node:sqlite` (`server/data/futbol.db`) | D1 (`futboltipster` database) |
| `node-cron` (`SYNC_CRON`) | Cron Trigger `0 11 * * *` UTC (= 06:00 America/Guayaquil, no DST) |
| FastAPI ml-service (`ML_URL`) | In-process TypeScript inference (`worker/src/inference`) |
| ESPN fixtures (`server/src/providers/espn.ts`) | football-data.org for Europe + local relay for EC1 (see below) |
| In-memory rate limit | D1-backed rate limit |

TypeScript inference is verified by parity: `ml-service/scripts/generate_golden.py` dumps vectors from the real Python models into `worker/tests/golden/`, and `parity.test.ts` asserts delta < 1e-9.

### Fixture providers (cloud)

ESPN returns 403 to Cloudflare egress IPs, so the cloud sync is hybrid:

- **Europe** — football-data.org v4, free plan (10 req/min, no monthly cap, email-only signup). `GET /competitions/{PL,PD,BL1,SA,FL1}/matches?dateFrom=&dateTo=`, no season param needed. Status mapping: `TIMED/SCHEDULED`→pre, `IN_PLAY/PAUSED`→in, `FINISHED/AWARDED`→post, postponed/cancelled skipped. `shortName` matches the training names, `tla` feeds the crests, `crest` the logos. Costs ~6 requests/day.
- **EC1** — no free cloud provider covers Liga Pro. The local server (residential IP, ESPN works) pushes EC1 fixtures to `POST /api/ingest` after each sync (`server/src/services/cloudRelay.ts`, best-effort, EC1-only to avoid duplicating Europe under other ids). Needs `CLOUD_SYNC_URL` + `CLOUD_SYNC_TOKEN` locally and the `CLOUD_TOKEN` secret in cloud. Daily automation: `server/scripts/relay-ec1.ps1` (starts the stack if down and waits for the first tick) via a scheduled task — daily 06:05 + at log on, with wake timers; full command in `server/scripts/README.md`.

### Steps

```bash
# 1. Export artifacts (regenerates gitignored worker/data/*.json)
cd ml-service && python scripts/export_to_json.py

# 2. Create the D1 database and paste its id into worker/wrangler.toml
cd ../worker && wrangler d1 create futboltipster
wrangler d1 migrations apply futboltipster --remote

# 3. Secrets and deploy
wrangler secret put REFRESH_TOKEN
wrangler secret put FOOTBALL_DATA_KEY
wrangler secret put CLOUD_TOKEN
wrangler deploy

# 4. Pages: connect the repo (branch master), root web, build npm run build,
# output dist, NODE_VERSION=22, with
# VITE_API_URL=https://<worker>.workers.dev/api
```

### Free-tier constraints (hard-enforced since Sep 2026)

- **10ms CPU per invocation**: the cron runs the full sync (football-data.org fetch is ~6 requests, no monthly cap) plus lazy catch-up; `GET /fixtures` predictions complete lazily (max 2 per request) and converge via the 60s auto-refresh. Partial 200s, never 503 for CPU.
- **D1**: 5M rows read / 100K written per day — 1–2 SELECTs + ≤2 writes per request, `Cache-Control: max-age=60` on GETs.
- **Worker size** 3MB gzip (current bundle ~40KB).

### Rollback

Point `VITE_API_URL` back to the previous API. The local stack (Express + SQLite + FastAPI) is untouched by this deploy.

## License

MIT — see [LICENSE](LICENSE).

## Author

Pablo Domínguez — [GitHub](https://github.com/Pa004) · [LinkedIn](https://www.linkedin.com/in/pabl004-dev)