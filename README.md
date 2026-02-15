# fittober-platform

Full-stack serverless fitness tracker built for a month-long team challenge. Polls GitHub Gists for activity data, stores it in PostgreSQL with deduplication, serves a real-time dashboard, and sends daily email digests with embedded charts.

**Live:** [Dashboard](https://pushpullleg.github.io/fitness-tracker/) · [API](https://fitness-tracker-flame-kappa.vercel.app/health)

## Architecture

```
GitHub Gists (4 sources)
        │
        ▼
GitHub Actions (cron: every 15 min)
        │
        ▼
Node.js/Express API (Vercel serverless)
        │
        ├──▶ PostgreSQL (Supabase) ──▶ Dashboard (GitHub Pages + Chart.js)
        │
        └──▶ SendGrid (daily digest emails with QuickChart.io embeds)
```

## Stack

| Layer | Tech |
|-------|------|
| Backend | Node.js 22, Express 4.18, `pg` connection pooling (max: 1 for serverless) |
| Database | PostgreSQL on Supabase — UUID primary keys, JSONB raw storage, unique constraint deduplication |
| Frontend | Vanilla JS + Chart.js 4.4 doughnut charts, auto-refresh every 60s |
| Email | SendGrid with HTML templates, QuickChart.io for embedded chart images |
| CI/CD | 3 GitHub Actions workflows: gist polling (15 min), daily digest (2 PM CST), weekly summary |
| Hosting | Vercel (API), GitHub Pages (frontend) — $0/month total |

## What the backend does

- **Polls 4 GitHub Gists** via `axios`, normalizes member names, handles multiple JSON schema formats
- **Deduplicates** using `ON CONFLICT (log_id, source_gist) DO NOTHING` — no duplicate entries ever
- **Serves REST API:** `/aggregates.json` (team stats), `/api/recent` (latest activities), `/health` (status)
- **Generates HTML email digests** with per-member breakdowns, team standings table, and embedded doughnut charts via QuickChart.io
- **Graceful degradation** — runs without SendGrid (emails disabled), runs without DB (clear error messages), handles pool errors

## API endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check with environment status |
| `/aggregates.json` | GET | Team member totals, sorted by minutes |
| `/api/recent?limit=5` | GET | Most recent activities |
| `/api/refresh` | GET/POST | Manually trigger gist polling |
| `/api/send-digest` | GET/POST | Send daily email to all recipients |
| `/api/test-digest` | GET | Send test email to sender only |
| `/api/webhook` | POST | GitHub webhook — responds immediately, processes in background |

## Database schema

```sql
activities (
  uid           UUID PRIMARY KEY,
  log_id        TEXT NOT NULL,
  member        TEXT NOT NULL,
  activity      TEXT NOT NULL,
  duration_min  INTEGER NOT NULL,
  ts            TIMESTAMPTZ NOT NULL,
  source_gist   TEXT NOT NULL,
  raw_json      JSONB NOT NULL,
  UNIQUE (log_id, source_gist)
)
-- 4 indexes: member, timestamp, source_gist, inserted_at
-- 2 views: member_stats, daily_activity_summary
```

## Project structure

```
api/index.js              Vercel serverless entry point
backend/
  index.js                Express app — 960 lines: polling, API, email templating
  database.sql            PostgreSQL schema with indexes and views
  test-email.js           SendGrid connectivity test
frontend/
  index.html              Dashboard — Chart.js doughnut, auto-refresh, mobile responsive
.github/workflows/
  auto-refresh.yml        Polls gists every 15 minutes
  email-digest.yml        Sends daily digest at 2 PM CST
  weekly-digest.yml       Sends weekly summary
vercel.json               API route rewrites
```

## Setup

```bash
git clone https://github.com/pushpullleg/fittober-platform.git
cd fittober-platform/backend
cp env.example .env
# Edit .env: DATABASE_URL, SENDGRID_API_KEY, GIST_URL_* (x4)
npm install && npm start
```

Detailed guides: [SETUP.md](./SETUP.md) · [EMAIL_SETUP.md](./EMAIL_SETUP.md)

## Team

Built by students at Texas A&M University Commerce for the Fittober 2025 challenge (October 1-31, 2025). 4 team members, 1,620+ total minutes tracked.
