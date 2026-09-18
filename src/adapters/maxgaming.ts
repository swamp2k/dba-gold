import { AdapterListing, Condition } from "./types";

const BASE = "https://www.maxgaming.dk";
const MAX_HTML_BYTES = 3_000_000;

function parsePrice(raw: string): number | null {
  const digits = raw.replace(/[^\d]/g, "");
  if (!digits) return null;
  const price = Number(digits);
  return Number.isFinite(price) ? price : null;
}

function parseCondition(title: string): Condition {
  const lower = title.toLocaleLowerCase("da-DK");
  if (lower.includes("(refurbished)")) return "refurb";
  if (lower.includes("(demo)")) return "demo";
  if (lower.includes("(open box)") || lower.includes("(openbox)")) return "open-box";
  if (lower.includes("(retur)") || lower.includes("(returned)")) return "returned";
  return null;
}

function extractListings(html: string): AdapterListing[] {
  const starts: number[] = [];
  const marker = '<div class="PT_Wrapper">';
  let from = 0;
  while (true) {
    const idx = html.indexOf(marker, from);
    if (idx < 0) break;
    starts.push(idx);
    from = idx + marker.length;
  }
  starts.push(html.length);

  const out: AdapterListing[] = [];
  for (let i = 0; i < starts.length - 1; i++) {
    const block = html.slice(starts[i], starts[i + 1]);
    const link = block.match(/PT_Lank"\s+href="([^"]+)"\s+title="([^"]+)"/);
    const artnr = block.match(/data-artnr="([^"]+)"/);
    if (!link || !artnr) continue;

    const priceMatch = block.match(/PT_Pris(?:Kampanj|Normal)">([^<]+)</);
    const price = priceMatch ? parsePrice(priceMatch[1]) : null;
    if (price === null) continue;

    const originalMatch = block.match(/PT_PrisOrdinarie">\(([^<]+)\)</);
    const originalPrice = originalMatch ? parsePrice(originalMatch[1]) : null;

    const name = link[2].trim();
    out.push({
      id: artnr[1],
      name,
      price,
      originalPrice: originalPrice !== null && originalPrice > price ? originalPrice : null,
      currency: "DKK",
      condition: parseCondition(name),
      url: new URL(link[1], BASE).toString(),
    });
  }
  return out;
}

export async function scrape(searchUrl: string): Promise<AdapterListing[]> {
  const response = await fetch(searchUrl, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; DBA-Gold-ItemWatch/1.0)",
      "Accept-Language": "da-DK,da;q=0.9,en;q=0.8",
    },
    cf: { cacheTtl: 900, cacheEverything: true },
  } as RequestInit);
  if (!response.ok) throw new Error(`MaxGaming returned HTTP ${response.status}`);
  const contentLength = Number(response.headers.get("content-length") ?? "0");
  if (contentLength > MAX_HTML_BYTES) throw new Error("MaxGaming page too large");
  const html = await response.text();
  return extractListings(html);
}
