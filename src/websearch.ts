export interface BrowserBinding {
  quickAction(action: string, options: Record<string, unknown>): Promise<Response>;
}

const MAX_SEARCH_MARKDOWN_CHARS = 14_000;

export function cleanQueries(value: unknown, max: number): string[] {
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
    if (result.length >= max) break;
  }
  return result;
}

function googleSearchUrl(query: string): string {
  const url = new URL("https://www.google.com/search");
  url.searchParams.set("hl", "da");
  url.searchParams.set("gl", "dk");
  url.searchParams.set("q", query);
  return url.toString();
}

function bingSearchUrl(query: string): string {
  const url = new URL("https://www.bing.com/search");
  url.searchParams.set("setlang", "da-DK");
  url.searchParams.set("cc", "dk");
  url.searchParams.set("q", query);
  return url.toString();
}

function searchMarkdownLooksUsable(markdown: string): boolean {
  if (markdown.trim().length < 700) return false;
  const lower = markdown.toLocaleLowerCase("da-DK");
  return ![
    "before you continue to google",
    "unusual traffic",
    "usædvanlig trafik",
    "consent.google",
  ].some(marker => lower.includes(marker));
}

async function renderMarkdown(browser: BrowserBinding, url: string): Promise<string> {
  const response = await browser.quickAction("markdown", { url });
  if (!response.ok) throw new Error(`Browser Run returned ${response.status} for search lookup`);
  const text = await response.text();
  return text.slice(0, MAX_SEARCH_MARKDOWN_CHARS);
}

export async function renderSearchResults(browser: BrowserBinding, query: string): Promise<{ sourceUrl: string; markdown: string }> {
  const googleUrl = googleSearchUrl(query);
  try {
    const markdown = await renderMarkdown(browser, googleUrl);
    if (searchMarkdownLooksUsable(markdown)) return { sourceUrl: googleUrl, markdown };
  } catch (error) {
    console.error(JSON.stringify({ event: "web_search_google_lookup_failed", query, error: String(error) }));
  }

  const bingUrl = bingSearchUrl(query);
  const markdown = await renderMarkdown(browser, bingUrl);
  if (!searchMarkdownLooksUsable(markdown)) throw new Error("No usable search result page returned");
  return { sourceUrl: bingUrl, markdown };
}
