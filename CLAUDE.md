# DBA Gold

AI-powered analyzer for [DBA.dk](https://www.dba.dk) listings (Denmark's largest second-hand
marketplace). A user pastes a DBA search URL plus an analysis prompt; the app fetches **every**
listing in the search, feeds them to a Claude model, and streams back an opinionated verdict on
the best deals. Runs as a single Cloudflare Worker serving a static frontend + a small JSON/SSE API.

## Stack

- **Cloudflare Worker** (`src/index.ts`) — API, SSE streaming, scheduled cron, static-asset serving.
- **Static frontend** (`public/index.html`) — single-file app (vanilla JS + `marked` for Markdown).
- **KV** (`DBA_GOLD_DATA`) — stores search history and recurring searches.
- **Anthropic SDK** (`@anthropic-ai/sdk`) — model calls.

## Commands

- `npm run dev` — local dev (`wrangler dev`). Needs `.dev.vars` with `ANTHROPIC_API_KEY`.
- `npm run type-check` — `tsc --noEmit`. Run before deploying.
- `npm run deploy` — `wrangler deploy`.

## Architecture notes (important — these encode hard-won lessons)

### Listing data comes from server-side scraping, NOT `web_fetch`
`web_fetch` only ever sees **page 1** of a DBA search, can't paginate (the model is forbidden from
constructing URLs), and doesn't execute JavaScript. That made multi-category searches look
"limited to GPUs" — it was just a page-1 sampling artifact.

Instead, the Worker (`fetchAllListings`) fetches every page itself (`&page=1..N`, parallel batches
of `FETCH_CONCURRENCY`, capped at `MAX_PAGES`) and parses the **schema.org JSON-LD**
(`CollectionPage` → `ItemList`) embedded in each page's HTML (`extractListings`). Listings are
deduped by item ID and passed to the model as a compact `ID<TAB>PRICE<TAB>TITLE` block — ~1500
listings ≈ 25–30k tokens. If a URL yields zero listings (e.g. a single item page), it falls back to
the old `web_fetch` + `web_search` tool path.

### Models
`ALLOWED_MODELS` = Haiku 4.5 (default), Sonnet 4.6, Opus 4.8. **Haiku does not support programmatic
tool calling**, so the `web_fetch`/`web_search` server tools must set `allowed_callers: ["direct"]`
or Haiku 400s. This only matters on the fallback path now that scraping is server-side.

### Auth = Cloudflare Access (Zero Trust)
There is **no app-level login**. The `workers.dev` hostname is gated by Cloudflare Access; the
Worker trusts that every request reaching it is already authenticated. "Log out" links to
`/cdn-cgi/access/logout`. Allowed identities are managed in the Zero Trust dashboard.

### Secrets
Only `ANTHROPIC_API_KEY` (set via `wrangler secret put`). The former `AUTH_USERNAME`/`AUTH_PASSWORD`
were removed when Access was added.

## Features

- **Analyze** (`POST /api/analyze`, SSE) — scrape + stream analysis. Emits `status` events
  (page-fetch progress), `text` deltas, then `done`/`error`.
- **History** (`/api/history`) — last 50 runs, including the **full result text** (used for the
  in-app "View" and Markdown export).
- **Recurring searches** (`/api/recurring` + `scheduled` cron, hourly trigger) — daily/weekly
  re-runs; result stored in `lastResult`.
- **Markdown export** (frontend only) — downloads the current or a historical analysis as a `.md`
  file with a metadata header, for handing to another AI.

## Conventions

- Frontend inline `onclick` handlers can only reach **`function` declarations** (global object), not
  top-level `const`/`let`. Declare any handler-referenced helper with `function`.
- Keep `src/index.ts` single-file; it's small and intentionally dependency-light.
