import {
  DBA_ITEM_BASE,
  FETCH_CONCURRENCY,
  Listing,
  MAX_DBA_PAGE_BYTES,
  MAX_PAGES,
  WatchCandidate,
  WatchProfile,
  WatchState,
  WATCH_AI_MAX_LISTINGS,
} from "./shared";

function extractListings(html: string): Listing[] {
  const out: Listing[] = [];
  const re = /<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html))) {
    let data: unknown;
    try { data = JSON.parse(match[1].trim()); } catch { continue; }

    for (const node of Array.isArray(data) ? data : [data]) {
      const record = node as Record<string, unknown>;
      const mainEntity = record.mainEntity as Record<string, unknown> | undefined;
      const list = mainEntity?.["@type"] === "ItemList"
        ? mainEntity
        : record["@type"] === "ItemList" ? record : null;
      const elements = list?.itemListElement;
      if (!Array.isArray(elements)) continue;

      for (const element of elements) {
        if (!element || typeof element !== "object") continue;
        const item = (element as Record<string, unknown>).item;
        if (!item || typeof item !== "object") continue;
        const itemRecord = item as Record<string, unknown>;
        const offers = itemRecord.offers && typeof itemRecord.offers === "object"
          ? itemRecord.offers as Record<string, unknown>
          : undefined;
        const itemUrl = String(itemRecord.url ?? offers?.url ?? "");
        const id = itemUrl.split("/").filter(Boolean).pop() ?? "";
        const rawPrice = offers?.price;
        const parsedPrice = rawPrice !== null && rawPrice !== undefined && rawPrice !== ""
          ? Number(rawPrice) : null;
        out.push({
          id,
          name: String(itemRecord.name ?? itemRecord.description ?? "").trim(),
          price: parsedPrice !== null && Number.isFinite(parsedPrice) ? parsedPrice : null,
          currency: String(offers?.priceCurrency ?? "DKK"),
        });
      }
    }
  }
  return out;
}

function extractTotal(html: string): number | null {
  const match = html.match(/([\d.]+)\s+annonce/);
  if (!match) return null;
  const total = Number(match[1].replace(/\./g, ""));
  return Number.isFinite(total) ? total : null;
}

function pageUrl(rawUrl: string, page: number): string {
  const url = new URL(rawUrl);
  url.searchParams.set("page", String(page));
  return url.toString();
}

async function fetchPage(rawUrl: string, page: number): Promise<{ listings: Listing[]; total: number | null }> {
  const response = await fetch(pageUrl(rawUrl, page), {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; DBA-Gold/1.0)",
      "Accept-Language": "da-DK,da;q=0.9,en;q=0.8",
    },
    cf: { cacheTtl: 300, cacheEverything: true },
  } as RequestInit);
  if (!response.ok) return { listings: [], total: null };
  const contentLength = Number(response.headers.get("content-length") ?? "0");
  if (contentLength > MAX_DBA_PAGE_BYTES) return { listings: [], total: null };
  const html = await response.text();
  return { listings: extractListings(html), total: extractTotal(html) };
}

export async function fetchAllListings(
  rawUrl: string,
  onProgress?: (done: number, total: number) => void | Promise<void>,
): Promise<{ listings: Listing[]; total: number | null }> {
  const first = await fetchPage(rawUrl, 1);
  const byId = new Map<string, Listing>();
  for (const listing of first.listings) if (listing.id) byId.set(listing.id, listing);

  const perPage = Math.max(first.listings.length, 1);
  let pages = 1;
  if (first.total) pages = Math.min(Math.ceil(first.total / perPage), MAX_PAGES);
  await onProgress?.(1, pages);

  let next = 2;
  let ranOut = false;
  while (next <= pages && !ranOut) {
    const batch: number[] = [];
    for (let i = 0; i < FETCH_CONCURRENCY && next <= pages; i++) batch.push(next++);
    const results = await Promise.all(batch.map(page => fetchPage(rawUrl, page)));
    for (const result of results) {
      if (result.listings.length === 0) ranOut = true;
      for (const listing of result.listings) if (listing.id) byId.set(listing.id, listing);
    }
    await onProgress?.(Math.min(next - 1, pages), pages);
  }
  return { listings: [...byId.values()], total: first.total };
}

export function listingsBlock(dbaUrl: string, total: number | null, listings: Listing[]): string {
  const lines = listings.map(listing => `${listing.id}\t${listing.price ?? "?"}\t${listing.name}`).join("\n");
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

export function watchListingsBlock(profile: WatchProfile, state: WatchState, candidates: WatchCandidate[]): string {
  const limited = candidates.slice(0, WATCH_AI_MAX_LISTINGS);
  const lines = limited.map(candidate => [
    candidate.id,
    candidate.change,
    candidate.price ?? "?",
    candidate.previousPrice ?? "?",
    candidate.name,
  ].join("\t")).join("\n");

  return [
    `Watch name: ${profile.name}`,
    `Search URL: ${profile.url}`,
    `Criteria: ${profile.criteria}`,
    `Maximum preferred price: ${profile.maxPrice ?? "not set"} DKK`,
    `This is the first baseline run: ${state.baseline ? "yes" : "no"}`,
    `Relevant changed listings supplied: ${limited.length} of ${candidates.length}`,
    candidates.length > limited.length ? `Only the first ${WATCH_AI_MAX_LISTINGS} listings are included due to the analysis safety cap.` : "",
    "",
    "Each line is: ID<TAB>CHANGE<TAB>PRICE_DKK<TAB>PREVIOUS_PRICE_DKK<TAB>TITLE",
    lines,
  ].filter(Boolean).join("\n");
}
