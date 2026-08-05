import Anthropic from "@anthropic-ai/sdk";
import { fetchAllListings, watchListingsBlock } from "./dba";
import {
  Env,
  errorMessage,
  getWatchProfiles,
  getWatchState,
  INTERVAL_MS,
  json,
  Listing,
  normalizeDbaUrl,
  normalizeInterval,
  normalizeMaxPrice,
  normalizeModel,
  readJson,
  saveWatchProfiles,
  saveWatchState,
  WatchCandidate,
  WatchChange,
  WatchProfile,
  WatchProfileInput,
  WatchState,
  WatchSummary,
  WatchUserStatus,
  WATCH_REMOVED_RETENTION_MS,
  WATCH_STATE_PREFIX,
  WATCH_SYSTEM_PROMPT,
} from "./shared";

export function buildWatchState(
  profile: WatchProfile,
  currentListings: Listing[],
  previous: WatchState | null,
  totalReported: number | null,
  now: number,
): WatchState {
  const previousById = new Map((previous?.listings ?? []).map(candidate => [candidate.id, candidate]));
  const currentIds = new Set<string>();
  const next: WatchCandidate[] = [];

  for (const listing of currentListings) {
    if (!listing.id) continue;
    currentIds.add(listing.id);
    const prior = previousById.get(listing.id);
    let change: WatchChange = "unchanged";
    let previousPrice: number | null | undefined;

    if (!prior) change = "new";
    else if (prior.change === "removed") change = "returned";
    else if (listing.price !== null && prior.price !== null && listing.price < prior.price) {
      change = "price_drop";
      previousPrice = prior.price;
    } else if (listing.price !== null && prior.price !== null && listing.price > prior.price) {
      change = "price_increase";
      previousPrice = prior.price;
    }

    next.push({
      ...listing,
      firstSeen: prior?.firstSeen ?? now,
      lastSeen: now,
      previousPrice,
      change,
      userStatus: prior?.userStatus ?? "unreviewed",
    });
  }

  for (const prior of previous?.listings ?? []) {
    if (currentIds.has(prior.id)) continue;
    if (prior.change === "removed" && now - prior.lastSeen > WATCH_REMOVED_RETENTION_MS) continue;
    next.push({ ...prior, change: "removed" });
  }

  const order: Record<WatchChange, number> = {
    new: 0, returned: 1, price_drop: 2, price_increase: 3, unchanged: 4, removed: 5,
  };
  next.sort((left, right) => {
    const leftOverBudget = profile.maxPrice !== null && left.price !== null && left.price > profile.maxPrice ? 1 : 0;
    const rightOverBudget = profile.maxPrice !== null && right.price !== null && right.price > profile.maxPrice ? 1 : 0;
    return order[left.change] - order[right.change]
      || leftOverBudget - rightOverBudget
      || (left.price ?? Number.MAX_SAFE_INTEGER) - (right.price ?? Number.MAX_SAFE_INTEGER);
  });

  const active = next.filter(candidate => candidate.change !== "removed");
  const summary: WatchSummary = {
    totalActive: active.length,
    newCount: next.filter(candidate => candidate.change === "new").length,
    returnedCount: next.filter(candidate => candidate.change === "returned").length,
    priceDropCount: next.filter(candidate => candidate.change === "price_drop").length,
    priceIncreaseCount: next.filter(candidate => candidate.change === "price_increase").length,
    removedCount: next.filter(candidate => candidate.change === "removed").length,
    interestingCount: active.filter(candidate => candidate.userStatus === "interesting").length,
    contactedCount: active.filter(candidate => candidate.userStatus === "contacted").length,
  };

  return { profileId: profile.id, runAt: now, totalReported, baseline: previous === null, summary, listings: next };
}

export function watchAnalysisCandidates(profile: WatchProfile, state: WatchState): WatchCandidate[] {
  const changed = state.baseline
    ? state.listings.filter(candidate => candidate.change !== "removed")
    : state.listings.filter(candidate => ["new", "returned", "price_drop"].includes(candidate.change));
  return changed.filter(candidate =>
    profile.maxPrice === null || candidate.price === null || candidate.price <= profile.maxPrice);
}

async function analyzeWatchChanges(env: Env, profile: WatchProfile, state: WatchState): Promise<string> {
  const candidates = watchAnalysisCandidates(profile, state);
  if (candidates.length === 0) {
    return state.baseline
      ? "Ingen annoncer matchede profilens prisgrænse ved første kørsel."
      : "Ingen nye annoncer, tilbagevendte annoncer eller prisfald siden sidste kørsel.";
  }

  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const response = await client.messages.create({
    model: profile.model,
    max_tokens: 2200,
    system: WATCH_SYSTEM_PROMPT,
    messages: [{ role: "user", content: `Vurder ændringerne i denne DBA-overvågning.\n\n${watchListingsBlock(profile, state, candidates)}` }],
  });
  return response.content
    .map(block => block.type === "text" ? block.text : "")
    .filter(Boolean)
    .join("\n")
    .slice(0, 12000);
}

async function runWatchProfile(env: Env, profile: WatchProfile): Promise<WatchState> {
  const now = Date.now();
  const previous = await getWatchState(env, profile.id);
  const { listings, total } = await fetchAllListings(profile.url);
  if (listings.length === 0) {
    throw new Error("DBA returnerede ingen annoncer. Den eksisterende baseline blev ikke ændret.");
  }
  const state = buildWatchState(profile, listings, previous, total, now);
  const analysis = await analyzeWatchChanges(env, profile, state);
  await saveWatchState(env, state);
  profile.lastRun = now;
  profile.lastError = undefined;
  profile.lastAnalysis = analysis;
  profile.lastSummary = state.summary;
  return state;
}

async function createProfile(request: Request, env: Env): Promise<Response> {
  const body = await readJson<WatchProfileInput>(request);
  if (!body) return json({ error: "Invalid JSON body" }, 400);
  const url = normalizeDbaUrl(body.url ?? "");
  const name = (body.name ?? "").trim();
  const criteria = (body.criteria ?? "").trim();
  if (!url) return json({ error: "A valid https://www.dba.dk search URL is required" }, 400);
  if (!name) return json({ error: "name is required" }, 400);
  if (!criteria) return json({ error: "criteria is required" }, 400);

  const profile: WatchProfile = {
    id: crypto.randomUUID(),
    name: name.slice(0, 100),
    url,
    criteria: criteria.slice(0, 4000),
    maxPrice: normalizeMaxPrice(body.maxPrice),
    model: normalizeModel(body.model),
    interval: normalizeInterval(body.interval),
    enabled: body.enabled !== false,
    createdAt: Date.now(),
  };
  const profiles = await getWatchProfiles(env);
  profiles.push(profile);
  await saveWatchProfiles(env, profiles);
  return json(profile, 201);
}

async function updateProfile(
  request: Request,
  env: Env,
  profiles: WatchProfile[],
  profile: WatchProfile,
): Promise<Response> {
  const body = await readJson<WatchProfileInput>(request);
  if (!body) return json({ error: "Invalid JSON body" }, 400);
  let resetState = false;

  if (body.name !== undefined) {
    const name = body.name.trim();
    if (!name) return json({ error: "name cannot be empty" }, 400);
    profile.name = name.slice(0, 100);
  }
  if (body.url !== undefined) {
    const url = normalizeDbaUrl(body.url);
    if (!url) return json({ error: "A valid https://www.dba.dk search URL is required" }, 400);
    if (profile.url !== url) resetState = true;
    profile.url = url;
  }
  if (body.criteria !== undefined) {
    const criteria = body.criteria.trim();
    if (!criteria) return json({ error: "criteria cannot be empty" }, 400);
    profile.criteria = criteria.slice(0, 4000);
  }
  if (body.maxPrice !== undefined) profile.maxPrice = normalizeMaxPrice(body.maxPrice);
  if (body.model !== undefined) profile.model = normalizeModel(body.model);
  if (body.interval !== undefined) profile.interval = normalizeInterval(body.interval);
  if (body.enabled !== undefined) profile.enabled = Boolean(body.enabled);

  if (resetState) {
    profile.lastRun = undefined;
    profile.lastError = undefined;
    profile.lastAnalysis = undefined;
    profile.lastSummary = undefined;
    await env.DBA_GOLD_DATA.delete(`${WATCH_STATE_PREFIX}${profile.id}`);
  }
  await saveWatchProfiles(env, profiles);
  return json(profile);
}

async function runProfile(env: Env, profiles: WatchProfile[], profile: WatchProfile): Promise<Response> {
  try {
    const state = await runWatchProfile(env, profile);
    await saveWatchProfiles(env, profiles);
    return json({ profile, state });
  } catch (error) {
    profile.lastRun = Date.now();
    profile.lastError = errorMessage(error).slice(0, 500);
    await saveWatchProfiles(env, profiles);
    console.error(JSON.stringify({ event: "watch_run_failed", profileId: profile.id, error: profile.lastError }));
    return json({ error: profile.lastError }, 502);
  }
}

async function updateCandidate(
  request: Request,
  env: Env,
  profile: WatchProfile,
  listingId: string,
): Promise<Response> {
  const body = await readJson<{ userStatus?: WatchUserStatus }>(request);
  const allowed = new Set<WatchUserStatus>(["unreviewed", "interesting", "contacted", "dismissed"]);
  if (!body?.userStatus || !allowed.has(body.userStatus)) return json({ error: "Invalid userStatus" }, 400);

  const state = await getWatchState(env, profile.id);
  if (!state) return json({ error: "Watch profile has not been run yet" }, 404);
  const candidate = state.listings.find(item => item.id === listingId);
  if (!candidate) return json({ error: "Listing not found" }, 404);

  candidate.userStatus = body.userStatus;
  state.summary.interestingCount = state.listings.filter(item => item.change !== "removed" && item.userStatus === "interesting").length;
  state.summary.contactedCount = state.listings.filter(item => item.change !== "removed" && item.userStatus === "contacted").length;
  profile.lastSummary = state.summary;
  await saveWatchState(env, state);
  return json(candidate);
}

export async function routeWatchlists(request: Request, env: Env, pathname: string): Promise<Response> {
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length === 2) {
    if (request.method === "GET") return json(await getWatchProfiles(env));
    if (request.method === "POST") return createProfile(request, env);
    return json({ error: "Method not allowed" }, 405);
  }

  const profiles = await getWatchProfiles(env);
  const profileIndex = profiles.findIndex(item => item.id === segments[2]);
  if (profileIndex < 0) return json({ error: "Watch profile not found" }, 404);
  const profile = profiles[profileIndex];

  if (segments.length === 3) {
    if (request.method === "GET") return json({ profile, state: await getWatchState(env, profile.id) });
    if (request.method === "PATCH") return updateProfile(request, env, profiles, profile);
    if (request.method === "DELETE") {
      profiles.splice(profileIndex, 1);
      await Promise.all([
        saveWatchProfiles(env, profiles),
        env.DBA_GOLD_DATA.delete(`${WATCH_STATE_PREFIX}${profile.id}`),
      ]);
      return json({ ok: true });
    }
    return json({ error: "Method not allowed" }, 405);
  }

  if (segments.length === 4 && segments[3] === "run" && request.method === "POST") {
    return runProfile(env, profiles, profile);
  }
  if (segments.length === 5 && segments[3] === "listings" && request.method === "PATCH") {
    const response = await updateCandidate(request, env, profile, decodeURIComponent(segments[4]));
    if (response.ok) await saveWatchProfiles(env, profiles);
    return response;
  }
  return json({ error: "Not found" }, 404);
}

export async function doWatchProfiles(env: Env): Promise<void> {
  const profiles = await getWatchProfiles(env);
  const now = Date.now();
  let changed = false;

  for (const profile of profiles) {
    if (!profile.enabled) continue;
    const interval = INTERVAL_MS[profile.interval] ?? INTERVAL_MS.daily;
    if (profile.lastRun && now - profile.lastRun < interval) continue;
    try {
      await runWatchProfile(env, profile);
    } catch (error) {
      profile.lastRun = Date.now();
      profile.lastError = errorMessage(error).slice(0, 500);
      console.error(JSON.stringify({ event: "watch_run_failed", profileId: profile.id, error: profile.lastError }));
    }
    changed = true;
  }
  if (changed) await saveWatchProfiles(env, profiles);
}
