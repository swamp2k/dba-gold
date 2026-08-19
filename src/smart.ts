import Anthropic from "@anthropic-ai/sdk";
import { fetchAllListings, listingsBlock } from "./dba";
import { addHistory, CORS, DEFAULT_MODEL, Env, errorMessage, Listing, normalizeModel, readJson } from "./shared";

const PLANNER_MODEL = DEFAULT_MODEL;
const MAX_SEARCHES = 6;
const SEARCH_BATCH_SIZE = 2;
const SMART_AI_MAX_LISTINGS = 750;
const DBA_SEARCH_BASE = "https://www.dba.dk/recommerce/forsale/search";

export interface SmartSearchPlan {
  intent: string;
  summary: string;
  mustHave: string[];
  niceToHave: string[];
  avoid: string[];
  preferredModels: string[];
  maxPrice: number | null;
  queries: string[];
  urls: string[];
}

interface PlannerToolInput {
  intent?: unknown;
  summary?: unknown;
  mustHave?: unknown;
  niceToHave?: unknown;
  avoid?: unknown;
  preferredModels?: unknown;
  maxPrice?: unknown;
  queries?: unknown;
}

function cleanText(value: unknown, maxLength = 120): string {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function cleanList(value: unknown, maxItems: number): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    const text = cleanText(raw);
    const key = text.toLocaleLowerCase("da-DK");
    if (!text || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= maxItems) break;
  }
  return out;
}

function normalizePrice(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n);
}

export function buildDbaSearchUrl(query: string): string {
  const url = new URL(DBA_SEARCH_BASE);
  url.searchParams.set("q", query.trim());
  return url.toString();
}

function normalizePlan(input: PlannerToolInput): SmartSearchPlan {
  const queries = cleanList(input.queries, MAX_SEARCHES);
  if (queries.length === 0) throw new Error("Search planner returned no usable DBA queries");

  return {
    intent: cleanText(input.intent, 100) || "DBA product search",
    summary: cleanText(input.summary, 500),
    mustHave: cleanList(input.mustHave, 10),
    niceToHave: cleanList(input.niceToHave, 10),
    avoid: cleanList(input.avoid, 10),
    preferredModels: cleanList(input.preferredModels, 15),
    maxPrice: normalizePrice(input.maxPrice),
    queries,
    urls: queries.map(buildDbaSearchUrl),
  };
}

async function createSearchPlan(client: Anthropic, requestText: string): Promise<SmartSearchPlan> {
  const response = await client.messages.create({
    model: PLANNER_MODEL,
    max_tokens: 1400,
    system: `You are the query planner for DBA Gold, a Danish second-hand marketplace search assistant.

Translate a user's ordinary-language shopping request into a small set of REALISTIC DBA.dk free-text searches.

Rules:
- Return 3-6 concise search queries that a human could type into DBA.dk.
- Prefer concrete real product families/models when the user's needs make that useful.
- Include at least one broader fallback query so unusual titles and misspellings are not lost.
- Do not invent product models or specifications.
- Do not put price, condition, location, battery life, size, compatibility, or prose requirements into the query unless they are genuinely useful title terms.
- Extract those requirements separately instead.
- If the user states a maximum budget, set maxPrice to the amount in DKK; otherwise null.
- Keep queries short. Avoid near-duplicates.
- The downstream system builds DBA URLs itself. Never return URLs.`,
    tools: [{
      name: "build_search_plan",
      description: "Return the structured product-search plan that DBA Gold should execute.",
      input_schema: {
        type: "object",
        properties: {
          intent: { type: "string" },
          summary: { type: "string" },
          mustHave: { type: "array", items: { type: "string" } },
          niceToHave: { type: "array", items: { type: "string" } },
          avoid: { type: "array", items: { type: "string" } },
          preferredModels: { type: "array", items: { type: "string" } },
          maxPrice: { anyOf: [{ type: "number" }, { type: "null" }] },
          queries: { type: "array", minItems: 3, maxItems: MAX_SEARCHES, items: { type: "string" } },
        },
        required: ["intent", "summary", "mustHave", "niceToHave", "avoid", "preferredModels", "maxPrice", "queries"],
        additionalProperties: false,
      },
    }],
    tool_choice: { type: "tool", name: "build_search_plan" },
    messages: [{ role: "user", content: requestText }],
  });

  const toolUse = response.content.find(block => block.type === "tool_use" && block.name === "build_search_plan");
  if (!toolUse || toolUse.type !== "tool_use") throw new Error("Search planner did not return a structured plan");
  return normalizePlan(toolUse.input as PlannerToolInput);
}

async function fetchPlanListings(
  plan: SmartSearchPlan,
  send: (payload: object) => Promise<unknown>,
): Promise<{ listings: Listing[]; reportedTotal: number }> {
  const byId = new Map<string, Listing>();
  let reportedTotal = 0;

  for (let start = 0; start < plan.urls.length; start += SEARCH_BATCH_SIZE) {
    const batch = plan.urls.slice(start, start + SEARCH_BATCH_SIZE);
    const batchResults = await Promise.all(batch.map(async (url, offset) => {
      const index = start + offset;
      await send({ type: "status", message: `Søger DBA ${index + 1}/${plan.urls.length}: ${plan.queries[index]}…` });
      return fetchAllListings(url);
    }));

    for (const result of batchResults) {
      reportedTotal += result.total ?? result.listings.length;
      for (const listing of result.listings) {
        if (!listing.id) continue;
        if (plan.maxPrice !== null && listing.price !== null && listing.price > plan.maxPrice) continue;
        byId.set(listing.id, listing);
      }
    }
  }

  return { listings: [...byId.values()], reportedTotal };
}

function planBlock(plan: SmartSearchPlan): string {
  return [
    `Intent: ${plan.intent}`,
    `Interpretation: ${plan.summary || "not supplied"}`,
    `Maximum price: ${plan.maxPrice ?? "not set"} DKK`,
    `Must-have: ${plan.mustHave.join("; ") || "none"}`,
    `Nice-to-have: ${plan.niceToHave.join("; ") || "none"}`,
    `Avoid: ${plan.avoid.join("; ") || "none"}`,
    `Product families/models considered: ${plan.preferredModels.join("; ") || "none"}`,
    `DBA searches executed: ${plan.queries.join(" | ")}`,
  ].join("\n");
}

async function pumpStream(
  stream: AsyncIterable<unknown>,
  send: (payload: object) => Promise<unknown>,
): Promise<string> {
  let full = "";
  for await (const rawEvent of stream) {
    if (!rawEvent || typeof rawEvent !== "object") continue;
    const event = rawEvent as { type?: string; delta?: { type?: string; text?: string } };
    if (event.type === "content_block_delta" && event.delta?.type === "text_delta" && event.delta.text) {
      full += event.delta.text;
      await send({ type: "text", text: event.delta.text });
    }
  }
  return full;
}

export async function handleSmartAnalyze(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const body = await readJson<{ request?: string; model?: string }>(request);
  if (!body) return new Response(JSON.stringify({ error: "Invalid JSON body" }), { status: 400, headers: { "Content-Type": "application/json", ...CORS } });

  const requestText = (body.request ?? "").trim();
  if (requestText.length < 5) return new Response(JSON.stringify({ error: "Describe what you are looking for" }), { status: 400, headers: { "Content-Type": "application/json", ...CORS } });
  if (requestText.length > 4000) return new Response(JSON.stringify({ error: "Search description is too long" }), { status: 400, headers: { "Content-Type": "application/json", ...CORS } });

  const model = normalizeModel(body.model);
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const encoder = new TextEncoder();
  const { readable, writable } = new TransformStream<Uint8Array>();
  const writer = writable.getWriter();
  const send = (payload: object) => writer.write(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));

  ctx.waitUntil((async () => {
    let fullText = "";
    try {
      await send({ type: "status", message: "Forstår dit ønske og bygger DBA-søgninger…" });
      const plan = await createSearchPlan(client, requestText);
      await send({ type: "plan", plan });

      const { listings, reportedTotal } = await fetchPlanListings(plan, send);
      if (listings.length === 0) {
        await send({ type: "text", text: "Jeg fandt ingen DBA-annoncer på de planlagte søgninger." });
        await send({ type: "done" });
        await writer.close();
        return;
      }

      let candidates = listings;
      if (candidates.length > SMART_AI_MAX_LISTINGS) {
        candidates = candidates
          .sort((a, b) => (a.price ?? Number.MAX_SAFE_INTEGER) - (b.price ?? Number.MAX_SAFE_INTEGER))
          .slice(0, SMART_AI_MAX_LISTINGS);
        await send({ type: "status", message: `Fandt ${listings.length} unikke annoncer; analyserer de ${SMART_AI_MAX_LISTINGS} billigste efter sikkerhedsgrænsen…` });
      } else {
        await send({ type: "status", message: `Fandt ${listings.length} unikke annoncer. AI vurderer dem nu…` });
      }

      const stream = client.messages.stream({
        model,
        max_tokens: 4096,
        system: `You are DBA Gold Smart Search, an expert buyer's assistant for DBA.dk.

The user described a product need in ordinary language. A separate planner translated that into several DBA searches. You receive the plan plus deduplicated search-result listings containing only title, price and ID.

Be conservative about facts: never claim a specific listing has a feature unless it is explicit in the title. You MAY use general product-model knowledge to explain why a model family appears promising, but clearly distinguish model-level knowledge from facts verified in a specific listing. Tell the user what must be checked in the full ad.

Rank the best candidates against must-haves, nice-to-haves, avoid rules and budget. Prefer a short useful shortlist over a giant dump. Link recommended listings as https://www.dba.dk/recommerce/forsale/item/<ID>. Respond in the same language as the user's request.`,
        messages: [{
          role: "user",
          content: `${requestText}\n\n--- SEARCH PLAN ---\n${planBlock(plan)}\n\n--- MERGED DBA RESULTS ---\nCombined result count reported across searches before deduplication: ${reportedTotal}\nUnique listings after deduplication and explicit price filtering: ${listings.length}\n\n${listingsBlock("Multiple AI-planned DBA searches", null, candidates)}`,
        }],
      }) as unknown as AsyncIterable<unknown>;

      fullText = await pumpStream(stream, send);
      try {
        await addHistory(env, {
          url: plan.urls[0],
          prompt: `[Smart Search] ${requestText}`,
          model,
          preview: fullText.slice(0, 500),
          result: fullText,
        });
      } catch (error) {
        console.error(JSON.stringify({ event: "smart_history_write_failed", error: errorMessage(error) }));
      }

      await send({ type: "done" });
      await writer.close();
    } catch (error) {
      try {
        await send({ type: "error", message: errorMessage(error) });
        await writer.close();
      } catch {
        await writer.abort();
      }
    }
  })());

  return new Response(readable, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      ...CORS,
    },
  });
}
