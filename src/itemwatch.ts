import { scrape as scrapeMaxgaming } from "./adapters/maxgaming";
import { AdapterListing } from "./adapters/types";
import {
  Env,
  errorMessage,
  getItemWatchState,
  getItemWatches,
  ITEM_WATCH_ADAPTERS,
  ITEM_WATCH_HISTORY_MS,
  ITEM_WATCH_NEAR_LOW_MARGIN,
  ITEM_WATCH_STATE_PREFIX,
  ItemWatch,
  ItemWatchDeal,
  ItemWatchInput,
  ItemWatchProduct,
  ItemWatchState,
  INTERVAL_MS,
  json,
  normalizeInterval,
  readJson,
  saveItemWatchState,
  saveItemWatches,
} from "./shared";

async function runAdapter(watch: ItemWatch): Promise<AdapterListing[]> {
  if (watch.adapter === "maxgaming") return scrapeMaxgaming(watch.url);
  throw new Error(`Unknown adapter: ${watch.adapter}`);
}

export function buildItemWatchState(
  watch: ItemWatch,
  listings: AdapterListing[],
  previous: ItemWatchState | null,
  now: number,
): { state: ItemWatchState; deals: ItemWatchDeal[] } {
  const products: Record<string, ItemWatchProduct> = {};
  const deals: ItemWatchDeal[] = [];
  const baseline = previous === null;

  const keyword = watch.keyword?.toLocaleLowerCase("da-DK") ?? null;

  for (const listing of listings) {
    if (watch.maxPrice !== null && listing.price > watch.maxPrice) continue;
    if (keyword && !listing.name.toLocaleLowerCase("da-DK").includes(keyword)) continue;

    const prior = previous?.products[listing.id];
    const history = (prior?.history ?? []).filter(point => now - point.seenAt <= ITEM_WATCH_HISTORY_MS);
    const historicLow = history.length > 0 ? Math.min(...history.map(point => point.price)) : null;

    // "Deal" here means "currently a good offer", recomputed fresh every run —
    // not a one-time change event. (Event-style dedup belongs with a
    // notification channel, once one exists, not here.)
    if (watch.minDiscountPercent !== null && listing.originalPrice !== null) {
      const discountPercent = Math.round((1 - listing.price / listing.originalPrice) * 100);
      if (discountPercent >= watch.minDiscountPercent) {
        deals.push({
          productId: listing.id, name: listing.name, url: listing.url, price: listing.price,
          reason: "on_page_discount", discountPercent, originalPrice: listing.originalPrice,
        });
      }
    } else if (historicLow !== null) {
      if (listing.price <= historicLow) {
        deals.push({
          productId: listing.id, name: listing.name, url: listing.url,
          price: listing.price, historicLow, reason: "historic_low",
        });
      } else if (listing.price <= historicLow * (1 + ITEM_WATCH_NEAR_LOW_MARGIN)) {
        deals.push({
          productId: listing.id, name: listing.name, url: listing.url,
          price: listing.price, historicLow, reason: "near_historic_low",
        });
      }
    }

    history.push({ price: listing.price, seenAt: now });
    products[listing.id] = {
      id: listing.id, name: listing.name, url: listing.url, condition: listing.condition,
      price: listing.price, originalPrice: listing.originalPrice, history,
    };
  }

  return { state: { watchId: watch.id, runAt: now, baseline, products }, deals };
}

async function runItemWatch(env: Env, watch: ItemWatch): Promise<ItemWatchState> {
  const now = Date.now();
  const previous = await getItemWatchState(env, watch.id);
  const listings = await runAdapter(watch);
  if (listings.length === 0) {
    throw new Error(`${watch.adapter} returned no listings. Existing baseline was not changed.`);
  }
  const { state, deals } = buildItemWatchState(watch, listings, previous, now);
  await saveItemWatchState(env, state);
  watch.lastRun = now;
  watch.lastError = undefined;
  watch.lastDeals = deals;
  return state;
}

function normalizeItemWatchInput(body: ItemWatchInput, existing?: ItemWatch): {
  error?: string;
  patch?: Partial<ItemWatch>;
} {
  const patch: Partial<ItemWatch> = {};
  if (body.name !== undefined) {
    const name = body.name.trim();
    if (!name) return { error: "name cannot be empty" };
    patch.name = name.slice(0, 100);
  } else if (!existing) return { error: "name is required" };

  if (body.adapter !== undefined) {
    if (!ITEM_WATCH_ADAPTERS.has(body.adapter)) return { error: "Unsupported adapter" };
    patch.adapter = body.adapter;
  } else if (!existing) return { error: "adapter is required" };

  if (body.url !== undefined) {
    let url: URL;
    try { url = new URL(body.url.trim()); } catch { return { error: "url must be a valid https URL" }; }
    if (url.protocol !== "https:") return { error: "url must be a valid https URL" };
    patch.url = url.toString();
  } else if (!existing) return { error: "url is required" };

  if (body.keyword !== undefined) {
    const keyword = (body.keyword ?? "").trim();
    patch.keyword = keyword ? keyword.slice(0, 100) : null;
  }
  if (body.maxPrice !== undefined) {
    if (body.maxPrice === null || body.maxPrice === "") {
      patch.maxPrice = null;
    } else {
      const maxPrice = Number(body.maxPrice);
      if (!Number.isFinite(maxPrice) || maxPrice < 0) return { error: "maxPrice must be a positive number" };
      patch.maxPrice = Math.round(maxPrice);
    }
  }
  if (body.minDiscountPercent !== undefined) {
    if (body.minDiscountPercent === null || body.minDiscountPercent === "") {
      patch.minDiscountPercent = null;
    } else {
      const minDiscountPercent = Number(body.minDiscountPercent);
      if (!Number.isFinite(minDiscountPercent) || minDiscountPercent <= 0 || minDiscountPercent >= 100) {
        return { error: "minDiscountPercent must be between 0 and 100" };
      }
      patch.minDiscountPercent = Math.round(minDiscountPercent);
    }
  }
  if (body.interval !== undefined) patch.interval = normalizeInterval(body.interval);
  if (body.preferredHour !== undefined) {
    if (body.preferredHour === null || body.preferredHour === "") {
      patch.preferredHour = null;
    } else {
      const preferredHour = Number(body.preferredHour);
      if (!Number.isInteger(preferredHour) || preferredHour < 0 || preferredHour > 23) {
        return { error: "preferredHour must be between 0 and 23" };
      }
      patch.preferredHour = preferredHour;
    }
  }
  if (body.enabled !== undefined) patch.enabled = Boolean(body.enabled);

  return { patch };
}

async function createItemWatch(request: Request, env: Env): Promise<Response> {
  const body = await readJson<ItemWatchInput>(request);
  if (!body) return json({ error: "Invalid JSON body" }, 400);
  const { error, patch } = normalizeItemWatchInput(body);
  if (error || !patch) return json({ error }, 400);

  const watch: ItemWatch = {
    id: crypto.randomUUID(),
    name: patch.name!,
    adapter: patch.adapter!,
    url: patch.url!,
    keyword: patch.keyword ?? null,
    maxPrice: patch.maxPrice ?? null,
    minDiscountPercent: patch.minDiscountPercent ?? null,
    interval: patch.interval ?? normalizeInterval(undefined),
    preferredHour: patch.preferredHour ?? null,
    enabled: body.enabled !== false,
    createdAt: Date.now(),
  };
  const watches = await getItemWatches(env);
  watches.push(watch);
  await saveItemWatches(env, watches);
  return json(watch, 201);
}

async function updateItemWatch(
  request: Request, env: Env, watches: ItemWatch[], watch: ItemWatch,
): Promise<Response> {
  const body = await readJson<ItemWatchInput>(request);
  if (!body) return json({ error: "Invalid JSON body" }, 400);
  const { error, patch } = normalizeItemWatchInput(body, watch);
  if (error || !patch) return json({ error }, 400);

  const urlChanged = patch.url !== undefined && patch.url !== watch.url;
  const adapterChanged = patch.adapter !== undefined && patch.adapter !== watch.adapter;
  Object.assign(watch, patch);

  if (urlChanged || adapterChanged) {
    watch.lastRun = undefined;
    watch.lastError = undefined;
    watch.lastDeals = undefined;
    await env.DBA_GOLD_DATA.delete(`${ITEM_WATCH_STATE_PREFIX}${watch.id}`);
  }
  await saveItemWatches(env, watches);
  return json(watch);
}

async function runWatchNow(env: Env, watches: ItemWatch[], watch: ItemWatch): Promise<Response> {
  try {
    const state = await runItemWatch(env, watch);
    await saveItemWatches(env, watches);
    return json({ watch, state });
  } catch (error) {
    watch.lastRun = Date.now();
    watch.lastError = errorMessage(error).slice(0, 500);
    await saveItemWatches(env, watches);
    console.error(JSON.stringify({ event: "itemwatch_run_failed", watchId: watch.id, error: watch.lastError }));
    return json({ error: watch.lastError }, 502);
  }
}

export async function routeItemWatches(request: Request, env: Env, pathname: string): Promise<Response> {
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length === 2) {
    if (request.method === "GET") return json(await getItemWatches(env));
    if (request.method === "POST") return createItemWatch(request, env);
    return json({ error: "Method not allowed" }, 405);
  }

  const watches = await getItemWatches(env);
  const index = watches.findIndex(item => item.id === segments[2]);
  if (index < 0) return json({ error: "Item watch not found" }, 404);
  const watch = watches[index];

  if (segments.length === 3) {
    if (request.method === "GET") return json({ watch, state: await getItemWatchState(env, watch.id) });
    if (request.method === "PATCH") return updateItemWatch(request, env, watches, watch);
    if (request.method === "DELETE") {
      watches.splice(index, 1);
      await Promise.all([
        saveItemWatches(env, watches),
        env.DBA_GOLD_DATA.delete(`${ITEM_WATCH_STATE_PREFIX}${watch.id}`),
      ]);
      return json({ ok: true });
    }
    return json({ error: "Method not allowed" }, 405);
  }

  if (segments.length === 4 && segments[3] === "run" && request.method === "POST") {
    return runWatchNow(env, watches, watch);
  }
  return json({ error: "Not found" }, 404);
}

export async function doItemWatches(env: Env): Promise<void> {
  const watches = await getItemWatches(env);
  const now = Date.now();
  let changed = false;

  for (const watch of watches) {
    if (!watch.enabled) continue;
    const intervalMs = INTERVAL_MS[watch.interval] ?? INTERVAL_MS.daily;
    if (watch.lastRun && now - watch.lastRun < intervalMs) continue;
    if (watch.preferredHour !== null && new Date(now).getUTCHours() !== watch.preferredHour) continue;
    try {
      await runItemWatch(env, watch);
    } catch (error) {
      watch.lastRun = Date.now();
      watch.lastError = errorMessage(error).slice(0, 500);
      console.error(JSON.stringify({ event: "itemwatch_run_failed", watchId: watch.id, error: watch.lastError }));
    }
    changed = true;
  }
  if (changed) await saveItemWatches(env, watches);
}
