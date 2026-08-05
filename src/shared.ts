export interface Env {
  ANTHROPIC_API_KEY: string;
  ASSETS: Fetcher;
  DBA_GOLD_DATA: KVNamespace;
}

export interface HistoryEntry {
  id: string;
  url: string;
  prompt: string;
  model: string;
  timestamp: number;
  preview: string;
  result: string;
}

export type WatchInterval = "daily" | "weekly";
export type WatchChange = "new" | "returned" | "price_drop" | "price_increase" | "unchanged" | "removed";
export type WatchUserStatus = "unreviewed" | "interesting" | "contacted" | "dismissed";

export interface RecurringSearch {
  id: string;
  name: string;
  url: string;
  prompt: string;
  model: string;
  interval: WatchInterval;
  lastRun?: number;
  lastResult?: string;
}

export interface Listing {
  id: string;
  name: string;
  price: number | null;
  currency: string;
}

export interface WatchProfile {
  id: string;
  name: string;
  url: string;
  criteria: string;
  maxPrice: number | null;
  model: string;
  interval: WatchInterval;
  enabled: boolean;
  createdAt: number;
  lastRun?: number;
  lastError?: string;
  lastAnalysis?: string;
  lastSummary?: WatchSummary;
}

export interface WatchCandidate extends Listing {
  firstSeen: number;
  lastSeen: number;
  previousPrice?: number | null;
  change: WatchChange;
  userStatus: WatchUserStatus;
}

export interface WatchSummary {
  totalActive: number;
  newCount: number;
  returnedCount: number;
  priceDropCount: number;
  priceIncreaseCount: number;
  removedCount: number;
  interestingCount: number;
  contactedCount: number;
}

export interface WatchState {
  profileId: string;
  runAt: number;
  totalReported: number | null;
  baseline: boolean;
  summary: WatchSummary;
  listings: WatchCandidate[];
}

export interface WatchProfileInput {
  name?: string;
  url?: string;
  criteria?: string;
  maxPrice?: number | string | null;
  model?: string;
  interval?: WatchInterval;
  enabled?: boolean;
}

export const ALLOWED_MODELS = new Set(["claude-haiku-4-5-20251001", "claude-sonnet-4-6", "claude-opus-4-8"]);
export const DEFAULT_MODEL = "claude-haiku-4-5-20251001";
export const HISTORY_MAX = 50;
export const WATCH_PROFILE_KEY = "watch:profiles";
export const WATCH_STATE_PREFIX = "watch:state:";
export const WATCH_REMOVED_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const WATCH_AI_MAX_LISTINGS = 250;
export const MAX_DBA_PAGE_BYTES = 2_000_000;
export const MAX_PAGES = 40;
export const FETCH_CONCURRENCY = 6;
export const DBA_ITEM_BASE = "https://www.dba.dk/recommerce/forsale/item/";

export const INTERVAL_MS: Record<WatchInterval, number> = {
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
};

export const SYSTEM_PROMPT = `You are DBA Gold, an expert assistant for analyzing listings on DBA.dk, Denmark's largest second-hand marketplace.

You will be given EITHER a pre-extracted list of listings (the normal case) OR a DBA.dk URL to fetch with the web_fetch tool (fallback). When listings are provided directly, analyze all of them — they already span every page of the search, so never assume the search is limited to whatever appears first.

Your job:
1. Read every listing provided (title, price, and ID).
2. Apply the user's specific analysis criteria across the WHOLE set.
3. Give a clear, opinionated verdict with concrete recommendations. When you cite a listing, link it as https://www.dba.dk/recommerce/forsale/item/<ID>.

Key facts about DBA.dk:
- It is Denmark's largest second-hand marketplace (like Craigslist / eBay for Danes)
- Prices are in Danish Krone (DKK)
- Most sellers are private individuals — negotiating is normal

Format your response with headers and bullet points for readability.
Respond in the same language as the user's prompt (Danish or English).
If no listings are available, say so clearly.`;

export const WATCH_SYSTEM_PROMPT = `You are DBA Gold Watch, a conservative deal-monitoring assistant for DBA.dk.

You receive only structured search-result data: listing ID, title, price, and change type. Never invent mileage, year, service history, equipment, condition, location, engine type, ABS, fuel injection, passenger comfort, or other details that are not explicit in the title. Clearly state when an important fact must be checked in the full listing.

Prioritize genuinely relevant new listings and price drops against the user's criteria. Be opinionated, concise, and practical. Link every recommended listing as https://www.dba.dk/recommerce/forsale/item/<ID>.

Respond in the same language as the user's criteria. Use short headings and bullets.`;

export const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export async function getHistory(env: Env): Promise<HistoryEntry[]> {
  return JSON.parse((await env.DBA_GOLD_DATA.get("history")) ?? "[]") as HistoryEntry[];
}

export async function addHistory(env: Env, entry: Omit<HistoryEntry, "id" | "timestamp">): Promise<void> {
  const history = await getHistory(env);
  history.unshift({ ...entry, id: crypto.randomUUID(), timestamp: Date.now() });
  await env.DBA_GOLD_DATA.put("history", JSON.stringify(history.slice(0, HISTORY_MAX)));
}

export async function getRecurring(env: Env): Promise<RecurringSearch[]> {
  return JSON.parse((await env.DBA_GOLD_DATA.get("recurring")) ?? "[]") as RecurringSearch[];
}

export async function saveRecurring(env: Env, list: RecurringSearch[]): Promise<void> {
  await env.DBA_GOLD_DATA.put("recurring", JSON.stringify(list));
}

export async function getWatchProfiles(env: Env): Promise<WatchProfile[]> {
  return JSON.parse((await env.DBA_GOLD_DATA.get(WATCH_PROFILE_KEY)) ?? "[]") as WatchProfile[];
}

export async function saveWatchProfiles(env: Env, profiles: WatchProfile[]): Promise<void> {
  await env.DBA_GOLD_DATA.put(WATCH_PROFILE_KEY, JSON.stringify(profiles));
}

export async function getWatchState(env: Env, profileId: string): Promise<WatchState | null> {
  return env.DBA_GOLD_DATA.get<WatchState>(`${WATCH_STATE_PREFIX}${profileId}`, "json");
}

export async function saveWatchState(env: Env, state: WatchState): Promise<void> {
  await env.DBA_GOLD_DATA.put(`${WATCH_STATE_PREFIX}${state.profileId}`, JSON.stringify(state));
}

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...CORS },
  });
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function readJson<T>(request: Request): Promise<T | null> {
  const length = Number(request.headers.get("content-length") ?? "0");
  if (length > 64 * 1024) return null;
  try {
    return await request.json() as T;
  } catch {
    return null;
  }
}

export function normalizeDbaUrl(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl.trim());
    if (url.protocol !== "https:") return null;
    const host = url.hostname.toLowerCase();
    if (host !== "dba.dk" && host !== "www.dba.dk") return null;
    url.hash = "";
    url.searchParams.delete("page");
    return url.toString();
  } catch {
    return null;
  }
}

export function normalizeMaxPrice(value: WatchProfileInput["maxPrice"]): number | null {
  if (value === null || value === undefined || value === "") return null;
  const price = Number(value);
  if (!Number.isFinite(price) || price < 0) return null;
  return Math.round(price);
}

export function normalizeModel(model: string | undefined): string {
  return ALLOWED_MODELS.has(model ?? "") ? model! : DEFAULT_MODEL;
}

export function normalizeInterval(interval: WatchInterval | undefined): WatchInterval {
  return interval === "weekly" ? "weekly" : "daily";
}
