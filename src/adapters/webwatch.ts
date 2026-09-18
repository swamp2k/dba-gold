import Anthropic from "@anthropic-ai/sdk";
import type { Env } from "../shared";
import { BrowserBinding, cleanQueries, renderSearchResults } from "../websearch";
import { AdapterListing, Condition } from "./types";

const MAX_QUERIES = 4;
const QUERY_BATCH_SIZE = 2;
const MAX_CANDIDATES = 40;

type BrowserEnv = Env & { BROWSER?: BrowserBinding };

interface QueryPlanInput {
  queries?: unknown;
}

interface CandidateInput {
  name?: unknown;
  price?: unknown;
  originalPrice?: unknown;
  currency?: unknown;
  url?: unknown;
  condition?: unknown;
}

interface CandidatesToolInput {
  candidates?: unknown;
}

const CONDITIONS: readonly Condition[] = ["new", "demo", "refurb", "open-box", "returned", "used", null];

async function planQueries(client: Anthropic, criteria: string): Promise<string[]> {
  const response = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 600,
    system: `You create Danish web-search queries to hunt for current secondhand or discounted listings matching a
person's criteria, across the open web (not limited to any single site).

Rules:
- Return at most ${MAX_QUERIES} searches.
- Write queries in Danish, targeting Danish sellers/sites when the criteria implies Denmark.
- Vary the angle across queries (different phrasing, brands, or likely marketplaces) rather than
  near-duplicates of the same search.
- Do not invent brand or model names not implied by the criteria.`,
    tools: [{
      name: "web_watch_queries",
      description: "Return targeted Danish web searches for the given deal-hunting criteria.",
      input_schema: {
        type: "object",
        properties: {
          queries: { type: "array", minItems: 1, maxItems: MAX_QUERIES, items: { type: "string" } },
        },
        required: ["queries"],
        additionalProperties: false,
      },
    }],
    tool_choice: { type: "tool", name: "web_watch_queries" },
    messages: [{ role: "user", content: criteria }],
  });

  const toolUse = response.content.find(block => block.type === "tool_use" && block.name === "web_watch_queries");
  if (!toolUse || toolUse.type !== "tool_use") return [];
  return cleanQueries((toolUse.input as QueryPlanInput).queries, MAX_QUERIES);
}

function parseCondition(value: unknown): Condition {
  return typeof value === "string" && (CONDITIONS as readonly (string | null)[]).includes(value)
    ? (value as Condition) : null;
}

function hashId(input: string): string {
  let hash = 5381;
  for (let i = 0; i < input.length; i++) hash = ((hash << 5) + hash + input.charCodeAt(i)) | 0;
  return (hash >>> 0).toString(36);
}

async function extractCandidates(
  client: Anthropic,
  criteria: string,
  pages: { query: string; sourceUrl: string; markdown: string }[],
): Promise<AdapterListing[]> {
  const context = pages.map((page, index) => [
    `### Search ${index + 1}: ${page.query}`,
    `Result page: ${page.sourceUrl}`,
    page.markdown,
  ].join("\n")).join("\n\n---\n\n");

  const response = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 3000,
    system: `You extract concrete for-sale listings from rendered Danish web-search result pages.

The person's criteria: "${criteria}"

Rules:
- Only extract listings that genuinely match the criteria and have a visible price.
- NEVER invent a price, URL, name, or discount that is not explicitly visible in the text.
- "url" must be the actual listing/product URL from the page, not the search-engine URL.
- Include "originalPrice" ONLY when the page explicitly shows a higher original/normal price next to a
  discounted one (e.g. "Før 999 kr, nu 499 kr"). Omit it otherwise.
- "condition" must be one of: new, demo, refurb, open-box, returned, used — or omit it if unclear.
- Prefer Danish (.dk) sources when the criteria implies a Danish purchase.
- Return at most ${MAX_CANDIDATES} candidates, the best matches first.`,
    tools: [{
      name: "web_watch_candidates",
      description: "Return concrete for-sale listings extracted from the search result pages.",
      input_schema: {
        type: "object",
        properties: {
          candidates: {
            type: "array",
            maxItems: MAX_CANDIDATES,
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                price: { type: "number" },
                originalPrice: { type: "number" },
                currency: { type: "string" },
                url: { type: "string" },
                condition: { type: "string", enum: ["new", "demo", "refurb", "open-box", "returned", "used"] },
              },
              required: ["name", "price", "url"],
              additionalProperties: false,
            },
          },
        },
        required: ["candidates"],
        additionalProperties: false,
      },
    }],
    tool_choice: { type: "tool", name: "web_watch_candidates" },
    messages: [{ role: "user", content: context }],
  });

  const toolUse = response.content.find(block => block.type === "tool_use" && block.name === "web_watch_candidates");
  if (!toolUse || toolUse.type !== "tool_use") return [];
  const raw = (toolUse.input as CandidatesToolInput).candidates;
  if (!Array.isArray(raw)) return [];

  const out: AdapterListing[] = [];
  for (const item of raw as CandidateInput[]) {
    if (typeof item.name !== "string" || !item.name.trim()) continue;
    if (typeof item.url !== "string") continue;
    let url: URL;
    try { url = new URL(item.url); } catch { continue; }
    if (url.protocol !== "https:" && url.protocol !== "http:") continue;
    if (!url.hostname.toLowerCase().endsWith(".dk")) continue;

    const price = Number(item.price);
    if (!Number.isFinite(price) || price <= 0) continue;
    const originalPrice = item.originalPrice !== undefined ? Number(item.originalPrice) : null;

    const name = item.name.trim().slice(0, 200);
    out.push({
      id: hashId(`${url.hostname}|${name.toLocaleLowerCase("da-DK")}`),
      name,
      price: Math.round(price),
      originalPrice: originalPrice !== null && Number.isFinite(originalPrice) && originalPrice > price
        ? Math.round(originalPrice) : null,
      currency: typeof item.currency === "string" && item.currency ? item.currency : "DKK",
      condition: parseCondition(item.condition),
      url: url.toString(),
    });
  }
  return out;
}

export async function scrape(criteria: string, env: Env): Promise<AdapterListing[]> {
  const browser = (env as BrowserEnv).BROWSER;
  if (!browser) throw new Error("Web Watch kræver Browser Rendering (BROWSER-binding), som ikke er konfigureret.");

  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const queries = await planQueries(client, criteria);
  if (queries.length === 0) throw new Error("Kunne ikke generere søgninger ud fra kriterierne.");

  const pages: { query: string; sourceUrl: string; markdown: string }[] = [];
  for (let start = 0; start < queries.length; start += QUERY_BATCH_SIZE) {
    const batch = queries.slice(start, start + QUERY_BATCH_SIZE);
    const rendered = await Promise.all(batch.map(async query => {
      try {
        const { sourceUrl, markdown } = await renderSearchResults(browser, query);
        return { query, sourceUrl, markdown };
      } catch (error) {
        console.error(JSON.stringify({ event: "web_watch_lookup_failed", query, error: String(error) }));
        return null;
      }
    }));
    for (const result of rendered) if (result) pages.push(result);
  }
  if (pages.length === 0) throw new Error("Ingen brugbare søgeresultater kunne hentes fra Google/Bing.");

  return extractCandidates(client, criteria, pages);
}
