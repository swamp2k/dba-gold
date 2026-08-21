import Anthropic from "@anthropic-ai/sdk";
import { Env, Listing } from "./shared";
import { SmartSearchPlan } from "./smart";

const MAX_RETAIL_QUERIES = 8;
const RETAIL_QUERY_BATCH_SIZE = 2;
const MAX_RETAIL_MARKDOWN_CHARS = 14_000;
const RETAIL_CANDIDATE_TITLES = 80;

interface BrowserBinding {
  quickAction(action: string, options: Record<string, unknown>): Promise<Response>;
}

type BrowserEnv = Env & { BROWSER?: BrowserBinding };

interface RetailQueryPlanInput {
  queries?: unknown;
}

interface RetailResearchResult {
  query: string;
  sourceUrl: string;
  markdown: string;
}

function cleanQueries(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const result: string[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (typeof raw !== "string") continue;
    const query = raw.trim().slice(0, 140);
    const key = query.toLocaleLowerCase("da-DK");
    if (!query || seen.has(key)) continue;
    seen.add(key);
    result.push(query);
    if (result.length >= MAX_RETAIL_QUERIES) break;
  }
  return result;
}

function candidateTitleBlock(listings: Listing[]): string {
  return [...listings]
    .sort((a, b) => (a.price ?? Number.MAX_SAFE_INTEGER) - (b.price ?? Number.MAX_SAFE_INTEGER))
    .slice(0, RETAIL_CANDIDATE_TITLES)
    .map(item => `${item.price ?? "?"} DKK — ${item.name}`)
    .join("\n");
}

async function createRetailQueryPlan(
  client: Anthropic,
  requestText: string,
  plan: SmartSearchPlan,
  listings: Listing[],
): Promise<string[]> {
  const response = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 900,
    system: `You create web-search queries for price verification of second-hand products found on DBA.dk.

The goal is to establish CURRENT NEW RETAIL PRICES in Denmark so DBA Gold can calculate real discounts.

Rules:
- Return at most ${MAX_RETAIL_QUERIES} searches.
- Prefer exact manufacturer model codes or exact product names that actually occur in the supplied DBA titles.
- Prioritize the cheapest/promising DBA candidates and products likely to satisfy the user's request.
- A query should target Danish current retail pricing, e.g. \"Ryobi R18PD3-0 pris ny Danmark\".
- Do not search for generic category prices when an exact model can be identified.
- Do not invent model numbers.
- Distinguish bare tools from kits/battery bundles whenever the title makes that distinction visible.
- Price comparison sites such as Prisjagt and PriceRunner, manufacturer pages, and established Danish retailers are useful evidence.
- Never include DBA.dk in these retail-price queries.`,
    tools: [{
      name: "retail_queries",
      description: "Return targeted web searches for current Danish new prices.",
      input_schema: {
        type: "object",
        properties: {
          queries: {
            type: "array",
            minItems: 1,
            maxItems: MAX_RETAIL_QUERIES,
            items: { type: "string" },
          },
        },
        required: ["queries"],
        additionalProperties: false,
      },
    }],
    tool_choice: { type: "tool", name: "retail_queries" },
    messages: [{
      role: "user",
      content: `${requestText}\n\nSearch intent: ${plan.intent}\nMust-have: ${plan.mustHave.join("; ") || "none"}\nNice-to-have: ${plan.niceToHave.join("; ") || "none"}\n\nCheapest DBA candidate titles:\n${candidateTitleBlock(listings)}`,
    }],
  });

  const toolUse = response.content.find(block => block.type === "tool_use" && block.name === "retail_queries");
  if (!toolUse || toolUse.type !== "tool_use") return [];
  return cleanQueries((toolUse.input as RetailQueryPlanInput).queries);
}

function googleSearchUrl(query: string): string {
  const url = new URL("https://www.google.com/search");
  url.searchParams.set("hl", "da");
  url.searchParams.set("gl", "dk");
  url.searchParams.set("q", `${query} (Prisjagt OR PriceRunner OR Ryobi OR Bauhaus OR Proshop OR Homeshop OR Davidsen OR XL-BYG)`);
  return url.toString();
}

async function renderMarkdown(browser: BrowserBinding, url: string): Promise<string> {
  const response = await browser.quickAction("markdown", {
    url,
    gotoOptions: {
      waitUntil: "domcontentloaded",
      timeout: 15_000,
    },
  });
  if (!response.ok) throw new Error(`Browser Run returned ${response.status} for retail lookup`);
  const text = await response.text();
  return text.slice(0, MAX_RETAIL_MARKDOWN_CHARS);
}

export async function researchRetailPrices(
  env: Env,
  client: Anthropic,
  requestText: string,
  plan: SmartSearchPlan,
  listings: Listing[],
  send: (payload: object) => Promise<unknown>,
): Promise<string> {
  const browser = (env as BrowserEnv).BROWSER;
  if (!browser) return "Retail-price web research unavailable: Browser Run binding is not configured.";

  let queries: string[];
  try {
    queries = await createRetailQueryPlan(client, requestText, plan, listings);
  } catch (error) {
    console.error(JSON.stringify({ event: "retail_query_plan_failed", error: String(error) }));
    return "Retail-price web research failed while planning price checks.";
  }
  if (queries.length === 0) return "Retail-price web research found no exact products suitable for a reliable lookup.";

  await send({ type: "status", message: `Slår aktuelle nypriser op på nettet for ${queries.length} lovende modeller…` });

  const results: RetailResearchResult[] = [];
  for (let start = 0; start < queries.length; start += RETAIL_QUERY_BATCH_SIZE) {
    const batch = queries.slice(start, start + RETAIL_QUERY_BATCH_SIZE);
    const rendered = await Promise.all(batch.map(async query => {
      const sourceUrl = googleSearchUrl(query);
      try {
        const markdown = await renderMarkdown(browser, sourceUrl);
        return { query, sourceUrl, markdown } satisfies RetailResearchResult;
      } catch (error) {
        console.error(JSON.stringify({ event: "retail_lookup_failed", query, error: String(error) }));
        return null;
      }
    }));
    for (const result of rendered) if (result?.markdown) results.push(result);
  }

  if (results.length === 0) return "Retail-price web research was attempted, but no usable current price pages could be retrieved.";

  return results.map((result, index) => [
    `### Retail lookup ${index + 1}: ${result.query}`,
    `Search URL: ${result.sourceUrl}`,
    result.markdown,
  ].join("\n")).join("\n\n---\n\n");
}
