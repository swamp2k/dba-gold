import Anthropic from "@anthropic-ai/sdk";

interface Env {
  ANTHROPIC_API_KEY: string;
  ASSETS: Fetcher;
  DBA_GOLD_DATA: KVNamespace;
}

interface HistoryEntry {
  id: string;
  url: string;
  prompt: string;
  model: string;
  timestamp: number;
  preview: string;
  result: string;
}

interface RecurringSearch {
  id: string;
  name: string;
  url: string;
  prompt: string;
  model: string;
  interval: "daily" | "weekly";
  lastRun?: number;
  lastResult?: string;
}

interface Listing {
  id: string;
  name: string;
  price: number | null;
  currency: string;
}

// ── Constants ─────────────────────────────────────────

const ALLOWED_MODELS = new Set(["claude-haiku-4-5-20251001", "claude-sonnet-4-6", "claude-opus-4-8"]);
const DEFAULT_MODEL = "claude-haiku-4-5-20251001";
const HISTORY_MAX = 50;

// DBA pagination: fetch every page of a search server-side and parse the
// embedded schema.org JSON-LD, rather than relying on web_fetch (which only
// sees page 1 and cannot paginate).
const MAX_PAGES = 40;          // safety cap (~2000 listings)
const FETCH_CONCURRENCY = 6;   // pages fetched in parallel per batch
const DBA_ITEM_BASE = "https://www.dba.dk/recommerce/forsale/item/";

const INTERVAL_MS: Record<string, number> = {
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
};

const SYSTEM_PROMPT = `You are DBA Gold, an expert assistant for analyzing listings on DBA.dk, Denmark's largest second-hand marketplace.

You will be given EITHER a pre-extracted list of listings (the normal case) OR a DBA.dk URL to fetch with the web_fetch tool (fallback). When listings are provided directly, analyze all of them — they already span every page of the search, so never assume the search is limited to whatever appears first.

Your job:
1. Read every listing provided (title, price, and ID).
2. Apply the user's specific analysis criteria across the WHOLE set.
3. Give a clear, opinionated verdict with concrete recommendations. When you cite a listing, link it as https://www.dba.dk/recommerce/forsale/item/<ID>.

Key facts about DBA.dk:
- It is Denmark's largest second-hand marketplace (like Craigslist / eBay for Danes)
- Prices are in Danish Krone (DKK). Roughly: 7 DKK = 1 USD, 7.5 DKK = 1 EUR
- Most sellers are private individuals — negotiating is normal
- Common categories: electronics, furniture, clothes, cars, bicycles, tools, instruments

Format your response with headers and bullet points for readability.
Respond in the same language as the user's prompt (Danish or English).
If no listings are available, say so clearly.`;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

// Access control is handled at the edge by Cloudflare Access (Zero Trust),
// which gates every request to this hostname before it reaches the Worker.

// ── KV helpers ────────────────────────────────────────

async function getHistory(env: Env): Promise<HistoryEntry[]> {
  return JSON.parse((await env.DBA_GOLD_DATA.get("history")) ?? "[]");
}

async function addHistory(env: Env, entry: Omit<HistoryEntry, "id" | "timestamp">): Promise<void> {
  const history = await getHistory(env);
  history.unshift({ ...entry, id: crypto.randomUUID(), timestamp: Date.now() });
  await env.DBA_GOLD_DATA.put("history", JSON.stringify(history.slice(0, HISTORY_MAX)));
}

async function getRecurring(env: Env): Promise<RecurringSearch[]> {
  return JSON.parse((await env.DBA_GOLD_DATA.get("recurring")) ?? "[]");
}

async function saveRecurring(env: Env, list: RecurringSearch[]): Promise<void> {
  await env.DBA_GOLD_DATA.put("recurring", JSON.stringify(list));
}

// ── Response helpers ──────────────────────────────────

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

// ── DBA scraping (server-side pagination) ─────────────

// Extract listings from a page's schema.org JSON-LD (CollectionPage > ItemList).
function extractListings(html: string): Listing[] {
  const out: Listing[] = [];
  const re = /<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    let data: unknown;
    try { data = JSON.parse(m[1].trim()); } catch { continue; }
    for (const node of Array.isArray(data) ? data : [data]) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const n = node as any;
      const list = n?.mainEntity?.["@type"] === "ItemList" ? n.mainEntity
                 : n?.["@type"] === "ItemList" ? n : null;
      if (!Array.isArray(list?.itemListElement)) continue;
      for (const el of list.itemListElement) {
        const it = el?.item;
        if (!it) continue;
        const url: string = it.url ?? it.offers?.url ?? "";
        const id = url.split("/").filter(Boolean).pop() ?? "";
        const priceRaw = it.offers?.price;
        const price = priceRaw != null && priceRaw !== "" ? Number(priceRaw) : null;
        out.push({
          id,
          name: String(it.name ?? it.description ?? "").trim(),
          price: Number.isFinite(price as number) ? price : null,
          currency: it.offers?.priceCurrency ?? "DKK",
        });
      }
    }
  }
  return out;
}

// Total result count from the page text ("1.555 annonce(r)…"). Best-effort hint.
function extractTotal(html: string): number | null {
  const m = html.match(/([\d.]+)\s+annonce/);
  if (!m) return null;
  const n = Number(m[1].replace(/\./g, ""));
  return Number.isFinite(n) ? n : null;
}

function pageUrl(rawUrl: string, page: number): string {
  const u = new URL(rawUrl);
  u.searchParams.set("page", String(page));
  return u.toString();
}

async function fetchPage(rawUrl: string, page: number): Promise<{ listings: Listing[]; total: number | null }> {
  const res = await fetch(pageUrl(rawUrl, page), {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; DBA-Gold/1.0)",
      "Accept-Language": "da-DK,da;q=0.9,en;q=0.8",
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    cf: { cacheTtl: 300, cacheEverything: true } as any,
  });
  if (!res.ok) return { listings: [], total: null };
  const html = await res.text();
  return { listings: extractListings(html), total: extractTotal(html) };
}

// Fetch every page of a DBA search and return the deduped listing set.
async function fetchAllListings(
  rawUrl: string,
  onProgress?: (done: number, total: number) => void,
): Promise<{ listings: Listing[]; total: number | null }> {
  const first = await fetchPage(rawUrl, 1);
  const byId = new Map<string, Listing>();
  for (const l of first.listings) if (l.id) byId.set(l.id, l);

  const perPage = Math.max(first.listings.length, 1);
  let pages = 1;
  if (first.total) pages = Math.min(Math.ceil(first.total / perPage), MAX_PAGES);
  onProgress?.(1, pages);

  let next = 2;
  let ranOut = false;
  while (next <= pages && !ranOut) {
    const batch: number[] = [];
    for (let i = 0; i < FETCH_CONCURRENCY && next <= pages; i++) batch.push(next++);
    const results = await Promise.all(batch.map(p => fetchPage(rawUrl, p)));
    for (const r of results) {
      if (r.listings.length === 0) ranOut = true; // past the last real page
      for (const l of r.listings) if (l.id) byId.set(l.id, l);
    }
    onProgress?.(Math.min(next - 1, pages), pages);
  }
  return { listings: [...byId.values()], total: first.total };
}

// Render listings as a compact, token-efficient block for the model.
function listingsBlock(dbaUrl: string, total: number | null, listings: Listing[]): string {
  const lines = listings.map(l => `${l.id}\t${l.price ?? "?"}\t${l.name}`).join("\n");
  return [
    `Search URL: ${dbaUrl}`,
    `Total results reported by DBA: ${total ?? "unknown"}`,
    `Listings fetched (all pages): ${listings.length}`,
    "",
    "Each line below is: ID<TAB>PRICE_DKK<TAB>TITLE",
    `Item URL = ${DBA_ITEM_BASE}<ID>`,
    "",
    lines,
  ].join("\n");
}

// Consume a streaming message, forwarding text deltas. Returns the full text.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function pumpStream(stream: any, send: (p: object) => Promise<unknown>): Promise<string> {
  let full = "";
  for await (const event of stream) {
    if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
      full += event.delta.text;
      await send({ type: "text", text: event.delta.text });
    }
  }
  return full;
}

// ── Analyze (streaming) ───────────────────────────────

async function handleAnalyze(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  let dbaUrl: string, userPrompt: string, model: string;
  try {
    const body = await request.json<{ dbaUrl?: string; userPrompt?: string; model?: string }>();
    dbaUrl = (body.dbaUrl ?? "").trim();
    userPrompt = (body.userPrompt ?? "").trim() || "Analyze the listings and identify the best deals.";
    model = ALLOWED_MODELS.has(body.model ?? "") ? body.model! : DEFAULT_MODEL;
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }
  if (!dbaUrl) return json({ error: "dbaUrl is required" }, 400);

  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const encoder = new TextEncoder();
  const { readable, writable } = new TransformStream<Uint8Array>();
  const writer = writable.getWriter();
  const send = (payload: object) =>
    writer.write(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));

  ctx.waitUntil((async () => {
    let fullText = "";
    try {
      await send({ type: "status", message: "Henter annoncer fra DBA…" });
      const { listings, total } = await fetchAllListings(dbaUrl, (done, totalPages) =>
        send({ type: "status", message: `Henter side ${done}/${totalPages}…` }));

      let stream;
      if (listings.length > 0) {
        await send({ type: "status", message: `Analyserer ${listings.length} annoncer…` });
        stream = client.messages.stream({
          model,
          max_tokens: 4096,
          system: SYSTEM_PROMPT,
          messages: [{ role: "user", content: `${userPrompt}\n\n--- DBA LISTINGS ---\n${listingsBlock(dbaUrl, total, listings)}` }],
        });
      } else {
        // Fallback: no listings parsed (e.g. a single item page) — let the model fetch directly.
        await send({ type: "status", message: "Analyserer…" });
        stream = client.messages.stream({
          model,
          max_tokens: 4096,
          system: SYSTEM_PROMPT,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          tools: [{ type: "web_fetch_20260209", name: "web_fetch", allowed_callers: ["direct"] } as any, { type: "web_search_20260209", name: "web_search", allowed_callers: ["direct"] } as any],
          messages: [{ role: "user", content: `Fetch and analyze the DBA.dk listings at:\n${dbaUrl}\n\n${userPrompt}` }],
        });
      }

      fullText = await pumpStream(stream, send);
      try { await addHistory(env, { url: dbaUrl, prompt: userPrompt, model, preview: fullText.slice(0, 500), result: fullText }); } catch { /* ignore */ }
      await send({ type: "done" });
      await writer.close();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      try { await send({ type: "error", message }); await writer.close(); } catch { await writer.abort(); }
    }
  })());

  return new Response(readable, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive", ...CORS },
  });
}

// ── Scheduled: run recurring searches ────────────────

async function doRecurring(env: Env): Promise<void> {
  const list = await getRecurring(env);
  const now = Date.now();
  let changed = false;

  for (const search of list) {
    const ms = INTERVAL_MS[search.interval] ?? INTERVAL_MS.daily;
    if (search.lastRun && now - search.lastRun < ms) continue;
    try {
      const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
      const { listings, total } = await fetchAllListings(search.url);
      const response = listings.length > 0
        ? await client.messages.create({
            model: search.model,
            max_tokens: 4096,
            system: SYSTEM_PROMPT,
            messages: [{ role: "user", content: `${search.prompt}\n\n--- DBA LISTINGS ---\n${listingsBlock(search.url, total, listings)}` }],
          })
        : await client.messages.create({
            model: search.model,
            max_tokens: 4096,
            system: SYSTEM_PROMPT,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            tools: [{ type: "web_fetch_20260209", name: "web_fetch", allowed_callers: ["direct"] } as any, { type: "web_search_20260209", name: "web_search", allowed_callers: ["direct"] } as any],
            messages: [{ role: "user", content: `Fetch and analyze the DBA.dk listings at:\n${search.url}\n\n${search.prompt}` }],
          });
      search.lastResult = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map(b => b.text).join("\n").slice(0, 8000);
      search.lastRun = now;
      changed = true;
    } catch (e) {
      console.error(`Recurring search ${search.id} failed:`, e);
    }
  }
  if (changed) await saveRecurring(env, list);
}

// ── Export (raw JSON) ─────────────────────────────────

async function handleExport(request: Request): Promise<Response> {
  let dbaUrl: string;
  try {
    const body = await request.json<{ dbaUrl?: string }>();
    dbaUrl = (body.dbaUrl ?? "").trim();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }
  if (!dbaUrl) return json({ error: "dbaUrl is required" }, 400);

  const { listings, total } = await fetchAllListings(dbaUrl);
  if (listings.length === 0) return json({ error: "No listings found. The URL may not be a DBA search page." }, 400);

  return json({ url: dbaUrl, exportedAt: new Date().toISOString(), total, listings });
}

// ── Router ────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const { pathname } = new URL(request.url);

    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });

    // API routes (gated upstream by Cloudflare Access)
    if (pathname.startsWith("/api/")) {
      if (pathname === "/api/analyze"   && request.method === "POST")   return handleAnalyze(request, env, ctx);
      if (pathname === "/api/export"    && request.method === "POST")   return handleExport(request);
      if (pathname === "/api/history"   && request.method === "GET")    return json(await getHistory(env));
      if (pathname === "/api/recurring" && request.method === "GET")    return json(await getRecurring(env));
      if (pathname === "/api/recurring" && request.method === "POST") {
        const body = await request.json<Partial<RecurringSearch>>();
        const entry: RecurringSearch = {
          id: crypto.randomUUID(),
          name: (body.name ?? "").trim() || "Unnamed search",
          url: body.url ?? "",
          prompt: body.prompt ?? "",
          model: ALLOWED_MODELS.has(body.model ?? "") ? body.model! : DEFAULT_MODEL,
          interval: body.interval === "weekly" ? "weekly" : "daily",
        };
        const list = await getRecurring(env);
        list.push(entry);
        await saveRecurring(env, list);
        return json(entry);
      }

      const id = pathname.split("/").pop()!;
      if (pathname.startsWith("/api/history/")   && request.method === "DELETE") {
        await env.DBA_GOLD_DATA.put("history", JSON.stringify((await getHistory(env)).filter(e => e.id !== id)));
        return json({ ok: true });
      }
      if (pathname.startsWith("/api/recurring/") && request.method === "DELETE") {
        await saveRecurring(env, (await getRecurring(env)).filter(s => s.id !== id));
        return json({ ok: true });
      }

      return json({ error: "Not found" }, 404);
    }

    return env.ASSETS.fetch(request);
  },

  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(doRecurring(env));
  },
};
