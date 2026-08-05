# DBA Gold

AI-powered deal finder og watchlist for [DBA.dk](https://www.dba.dk), Denmark's largest second-hand marketplace.

Paste a DBA search URL, describe what you're after, and DBA Gold fetches every listing in the search, runs it through a Claude model, and streams back an opinionated verdict on the best deals — across all categories, not just the first page.

It runs as a single Cloudflare Worker serving static frontend pages plus a JSON/SSE API.

## Features

- **Full-search analysis** — paginates the entire DBA search server-side and analyzes all listings at once.
- **Pick your model** — Haiku 4.5, Sonnet 4.6, or Opus 4.8.
- **Live streaming** — results stream in as the model writes, with page-fetch progress.
- **Search history** — every manual run is saved with its full result.
- **Markdown and JSON export** — export analyses or raw listing data.
- **Recurring searches** — re-run the original full analysis daily or weekly.
- **Watchlists** — track a persistent baseline and detect new, returned, price-changed, and removed listings.
- **Manual candidate status** — mark listings as interesting, contacted, dismissed, or unreviewed.
- **Motorcycle template** — prefilled criteria for lightweight adventure/dual-sport motorcycles with occasional passenger use.

## Pages

- `/` — original full-search analyzer.
- `/watchlist.html` — persistent watchlists and candidate tracking.

## How watchlists work

Each watch profile stores its configuration in Workers KV and keeps a separate listing snapshot. The first run creates a baseline. Later runs compare DBA's current search result with the previous snapshot and only send new, returned, or price-dropped listings to Claude. This reduces repeated AI usage while preserving a searchable history of active and recently removed listings.

The first milestone still relies on DBA search-result data: listing title, price, currency, and ID. It deliberately does not invent mileage, year, equipment, condition, or other facts that require opening the detail page. The next phases are documented in [`docs/MOTORCYCLE_WATCHLIST_PLAN.md`](docs/MOTORCYCLE_WATCHLIST_PLAN.md).

## Tech stack

- Cloudflare Workers — compute, SSE streaming, cron triggers, static assets
- Workers KV — search history, recurring searches, watch profiles, and listing snapshots
- Anthropic SDK — Claude model calls
- TypeScript — Worker API
- Vanilla HTML/CSS/JavaScript — analyzer and watchlist frontends

## Development

```bash
npm install
npm run dev
npm run type-check
```

Local development needs a `.dev.vars` file:

```text
ANTHROPIC_API_KEY="sk-ant-..."
```

## Deploy

```bash
npm run deploy
wrangler secret put ANTHROPIC_API_KEY
```

Access is gated by Cloudflare Access in front of the Worker's hostname. There is no application-level login.

## License

Personal project — not currently licensed for reuse.
