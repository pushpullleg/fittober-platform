# fittober-platform

A serverless fitness tracker built for a month-long team challenge. Team members log activity to GitHub Gists; a GitHub Actions cron job polls those gists every 15 minutes, deduplicates entries, and writes to PostgreSQL. A dashboard pulls from the API and auto-refreshes every 60 seconds. A daily email digest goes out at 2 PM with embedded charts.

**Live:** [Dashboard](https://pushpullleg.github.io/fitness-tracker/) · [API](https://fitness-tracker-flame-kappa.vercel.app/health)

Hosting is free — Vercel for the API, GitHub Pages for the frontend.

## Stack

- **Backend** — Node.js, Express, PostgreSQL (Supabase)
- **Frontend** — Vanilla JS, Chart.js
- **Email** — SendGrid with QuickChart.io for chart embeds
- **CI/CD** — 3 GitHub Actions workflows: poll (15 min), daily digest, weekly summary

## Running locally

```bash
git clone https://github.com/pushpullleg/fittober-platform.git
cd fittober-platform/backend
cp env.example .env   # fill in DATABASE_URL, SENDGRID_API_KEY, GIST_URL_* (x4)
npm install && npm start
```

## API endpoints

| Endpoint | Description |
|---|---|
| `GET /health` | Status check |
| `GET /aggregates.json` | Team totals, sorted by minutes |
| `GET /api/recent` | Latest activities |
| `GET /api/refresh` | Trigger a gist poll manually |
| `GET /api/send-digest` | Send the daily email |

## Structure

```
backend/
└── index.js          # Express app — polling, API routes, email templating
frontend/
└── index.html        # Dashboard with Chart.js and auto-refresh
.github/workflows/    # auto-refresh, email-digest, weekly-digest
database.sql          # schema with indexes and views
```

## License

MIT
