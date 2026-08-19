import { createRecurringSearch, doRecurring, handleAnalyze, handleExport } from "./analyze";
import {
  CORS,
  Env,
  getHistory,
  getRecurring,
  json,
  normalizeDbaUrl,
  readJson,
  RecurringSearch,
  saveRecurring,
} from "./shared";
import { handleSmartAnalyze } from "./smart";
import { doWatchProfiles, routeWatchlists } from "./watch";

async function serveMainPage(request: Request, env: Env): Promise<Response> {
  const response = await env.ASSETS.fetch(request);
  if (!response.ok || request.method === "HEAD") return response;

  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("text/html")) return response;

  const html = await response.text();
  const marker = '<div class="tagline">AI-powered DBA.dk listing analyzer</div>';
  const smartLink = '<a class="logout-btn" href="/smart.html">✨ Smart Search</a>';
  const integrated = html.includes(marker) && !html.includes('href="/smart.html"')
    ? html.replace(marker, `${marker}\n    ${smartLink}`)
    : html;

  const headers = new Headers(response.headers);
  headers.delete("content-length");
  return new Response(integrated, { status: response.status, statusText: response.statusText, headers });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const { pathname } = new URL(request.url);

    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });

    // API routes are gated upstream by Cloudflare Access.
    if (pathname.startsWith("/api/")) {
      if (pathname === "/api/analyze" && request.method === "POST") return handleAnalyze(request, env, ctx);
      if (pathname === "/api/smart-analyze" && request.method === "POST") return handleSmartAnalyze(request, env, ctx);
      if (pathname === "/api/export" && request.method === "POST") return handleExport(request);
      if (pathname === "/api/history" && request.method === "GET") return json(await getHistory(env));
      if (pathname.startsWith("/api/watchlists")) return routeWatchlists(request, env, pathname);
      if (pathname === "/api/recurring" && request.method === "GET") return json(await getRecurring(env));
      if (pathname === "/api/recurring" && request.method === "POST") {
        const body = await readJson<Partial<RecurringSearch>>(request);
        if (!body) return json({ error: "Invalid JSON body" }, 400);
        const url = normalizeDbaUrl(body.url ?? "");
        if (!url) return json({ error: "A valid https://www.dba.dk search URL is required" }, 400);
        const entry = createRecurringSearch(body, url);
        const list = await getRecurring(env);
        list.push(entry);
        await saveRecurring(env, list);
        return json(entry, 201);
      }

      const id = pathname.split("/").pop()!;
      if (pathname.startsWith("/api/history/") && request.method === "DELETE") {
        await env.DBA_GOLD_DATA.put("history", JSON.stringify((await getHistory(env)).filter(entry => entry.id !== id)));
        return json({ ok: true });
      }
      if (pathname.startsWith("/api/recurring/") && request.method === "DELETE") {
        await saveRecurring(env, (await getRecurring(env)).filter(search => search.id !== id));
        return json({ ok: true });
      }
      return json({ error: "Not found" }, 404);
    }

    if ((pathname === "/" || pathname === "/index.html") && (request.method === "GET" || request.method === "HEAD")) {
      return serveMainPage(request, env);
    }

    return env.ASSETS.fetch(request);
  },

  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(Promise.all([doRecurring(env), doWatchProfiles(env)]).then(() => undefined));
  },
};
