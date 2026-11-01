# NOW

## Doing
PR #5 merged at user request. Consolidating session instructions into main and removing non-main branches.

## State
- Reviewed main at `05214253129dffaf2f7d391a9261c2a45465a78d` (2026-10-11), README, root CLAUDE.md, API router, watch scheduling, JSON extraction, watchlist plan, CI workflow, recent commits and open PRs.
- Root CLAUDE.md existed; AGENTS.md and NOW.md did not. Preserved the full original instructions, copied them to AGENTS.md, and added identical session continuity rules. No HANDOVER.md or nested instruction files found in the inspected repository directories; nested files were not changed.
- App: TypeScript Cloudflare Worker, static frontends, Workers KV and Anthropic. Current code includes Smart Search, manual DBA analysis, watchlists, item/web monitoring, recurring runs and structured JSON extraction.
- Documentation drift: README describes `/` as the manual analyzer, but src/index.ts serves Smart Search there and manual analysis at `/manual.html`. CLAUDE.md's single-file architecture description predates the existing module split. Existing instructions preserved pending user direction.
- Latest merged changes: #8 handles model ID arrays wrapped in code fences (`245ace6`); #9 treats empty later extraction pages as search end and stops after two consecutive page failures (`0521425`).
- PR #5 merged as `00e7590`: failed watch profiles retry on the next hourly cron; successful runs retain normal cadence. Live runtime behavior is unverified.
- CI checks pull requests and main pushes with Node 24, npm ci, npm run type-check, and node tests/extract.test.mjs. No explicit contribution/branch policy was found; this session uses a branch and PR, consistent with recent merged changes.

## Next step
Next proposed work, pending user direction: reconcile documentation with current routes/modules and update the stale extraction test expectation introduced by #8.

## Blocked by
- Branch cleanup in progress; GitHub connector has no branch-delete action. Checking authenticated CLI access on the connected device.
- Local clone failed because the configured proxy at port 8080 was unreachable. GitHub connector supports repository reads and documentation publication. Local checks were not run. PR #10 CI type-check passed; extraction tests passed 9/10, failing at tests/extract.test.mjs:37 because a code-fenced ID array is now accepted by #8. Documentation-only changes do not modify that behavior. Live deployment behavior remains unverified.

## Updated
2026-11-01
