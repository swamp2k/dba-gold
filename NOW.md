# NOW

## Doing
Repository orientation complete; awaiting user direction before further implementation. This documentation branch aligns root instructions and records the session bookmark.

## State
- Reviewed main at `05214253129dffaf2f7d391a9261c2a45465a78d` (2026-10-11), README, root CLAUDE.md, API router, watch scheduling, JSON extraction, watchlist plan, CI workflow, recent commits and open PRs.
- Root CLAUDE.md existed; AGENTS.md and NOW.md did not. Preserved the full original instructions, copied them to AGENTS.md, and added identical session continuity rules. No HANDOVER.md or nested instruction files found in the inspected repository directories; nested files were not changed.
- App: TypeScript Cloudflare Worker, static frontends, Workers KV and Anthropic. Current code includes Smart Search, manual DBA analysis, watchlists, item/web monitoring, recurring runs and structured JSON extraction.
- Documentation drift: README describes `/` as the manual analyzer, but src/index.ts serves Smart Search there and manual analysis at `/manual.html`. CLAUDE.md's single-file architecture description predates the existing module split. Existing instructions preserved pending user direction.
- Latest merged changes: #8 handles model ID arrays wrapped in code fences (`245ace6`); #9 treats empty later extraction pages as search end and stops after two consecutive page failures (`0521425`).
- One pre-existing open PR: draft #5, `codex/retry-failed-dba-watch-scans` at `6e3063c`, changes the watch scheduling guard to retry profiles with lastError on the next hourly cron. Main still delays failed profiles for the normal interval. PR has a historical successful Cloudflare preview comment; current runtime behavior is unverified.
- CI checks pull requests and main pushes with Node 24, npm ci, npm run type-check, and node tests/extract.test.mjs. No explicit contribution/branch policy was found; this session uses a branch and PR, consistent with recent merged changes.

## Next step
After user direction: validate draft PR #5 against current main, cover failed-run retry and successful daily/weekly cadence, run type-check and extraction tests, then prepare it for review. Separately reconcile README and architecture guidance with current routes/modules.

## Blocked by
- Further implementation awaits user direction as requested.
- Local clone failed because the configured proxy at port 8080 was unreachable. GitHub connector supports repository reads and documentation publication. Local type-check/tests were not run; CI result and live deployment behavior are not yet verified.

## Updated
2026-11-01
