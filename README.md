# DBA Gold

AI-powered deal finder for [DBA.dk](https://www.dba.dk), Denmark's largest second-hand marketplace.

Paste a DBA search URL, describe what you're after, and DBA Gold fetches **every** listing in the
search, runs it through a Claude model, and streams back an opinionated verdict on the best deals —
across all categories, not just the first page.

It runs as a single [Cloudflare Worker](https://workers.cloudflare.com/) serving a static frontend
plus a small JSON/SSE API.

## Features

- **Full-search analysis** — paginates the entire DBA search server-side (not just page one) and
  analyzes all listings at once.
- **Pick your model** — Haiku 4.5 (fast & cheap, default), Sonnet 4.6, or Opus 4.8.
- **Live streaming** — results stream in as the model writes, with page-fetch progress.
- **Search history** — every run is saved with its full result; revisit or re-export any past run.
- **Markdown export** — download any analysis as a `.md` file to hand off to another tool or AI.
- **Recurring searches** — schedule a search to re-run daily or weekly.

## How it works

DBA embeds [schema.org](https://schema.org) `ItemList` JSON-LD in each search results page. The
Worker fetches every page (`?page=1..N`, in parallel batches), parses out each listing's title,
price, and ID, dedupes them, and passes the whole set to Claude as compact text. This sidesteps the
limitations of letting the model fetch pages itself — it can't paginate, and DBA's search UI is
JavaScript-rendered.

## Tech stack

- **Cloudflare Workers** — compute, SSE streaming, cron triggers, static assets
- **Workers KV** — search history and recurring searches
- **Anthropic SDK** — Claude model calls
- **TypeScript** — single-file Worker (`src/index.ts`); vanilla-JS frontend (`public/index.html`)

## Development

```bash
npm install
npm run dev          # local dev server (wrangler dev)
npm run type-check   # tsc --noEmit
```

Local dev needs a `.dev.vars` file with your Anthropic API key:

```
ANTHROPIC_API_KEY="sk-ant-..."
```

## Deploy

```bash
npm run deploy       # wrangler deploy
```

The deployed Worker needs the `ANTHROPIC_API_KEY` secret:

```bash
wrangler secret put ANTHROPIC_API_KEY
```

Access is gated by [Cloudflare Access](https://www.cloudflare.com/zero-trust/products/access/)
(Zero Trust) in front of the Worker's hostname — there is no app-level login.

## License

Personal project — not currently licensed for reuse.
