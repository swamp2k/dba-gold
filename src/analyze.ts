import Anthropic from "@anthropic-ai/sdk";
import { fetchAllListings, listingsBlock } from "./dba";
import {
  addHistory,
  Env,
  errorMessage,
  INTERVAL_MS,
  normalizeDbaUrl,
  normalizeModel,
  readJson,
  RecurringSearch,
  saveRecurring,
  SYSTEM_PROMPT,
  CORS,
  getRecurring,
  json,
} from "./shared";

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

export async function handleAnalyze(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const body = await readJson<{ dbaUrl?: string; userPrompt?: string; model?: string }>(request);
  if (!body) return json({ error: "Invalid JSON body" }, 400);

  const dbaUrl = normalizeDbaUrl(body.dbaUrl ?? "");
  const userPrompt = (body.userPrompt ?? "").trim() || "Analyze the listings and identify the best deals.";
  const model = normalizeModel(body.model);
  if (!dbaUrl) return json({ error: "A valid https://www.dba.dk search URL is required" }, 400);

  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const encoder = new TextEncoder();
  const { readable, writable } = new TransformStream<Uint8Array>();
  const writer = writable.getWriter();
  const send = (payload: object) => writer.write(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));

  ctx.waitUntil((async () => {
    let fullText = "";
    try {
      await send({ type: "status", message: "Henter annoncer fra DBA…" });
      const { listings, total } = await fetchAllListings(dbaUrl, (done, pages) =>
        send({ type: "status", message: `Henter side ${done}/${pages}…` }));

      let stream: AsyncIterable<unknown>;
      if (listings.length > 0) {
        await send({ type: "status", message: `Analyserer ${listings.length} annoncer…` });
        stream = client.messages.stream({
          model,
          max_tokens: 4096,
          system: SYSTEM_PROMPT,
          messages: [{ role: "user", content: `${userPrompt}\n\n--- DBA LISTINGS ---\n${listingsBlock(dbaUrl, total, listings)}` }],
        }) as unknown as AsyncIterable<unknown>;
      } else {
        await send({ type: "status", message: "Analyserer…" });
        stream = client.messages.stream({
          model,
          max_tokens: 4096,
          system: SYSTEM_PROMPT,
          tools: [
            { type: "web_fetch_20260209", name: "web_fetch", allowed_callers: ["direct"] },
            { type: "web_search_20260209", name: "web_search", allowed_callers: ["direct"] },
          ],
          messages: [{ role: "user", content: `Fetch and analyze the DBA.dk listings at:\n${dbaUrl}\n\n${userPrompt}` }],
        } as never) as unknown as AsyncIterable<unknown>;
      }

      fullText = await pumpStream(stream, send);
      try {
        await addHistory(env, {
          url: dbaUrl,
          prompt: userPrompt,
          model,
          preview: fullText.slice(0, 500),
          result: fullText,
        });
      } catch (error) {
        console.error(JSON.stringify({ event: "history_write_failed", error: errorMessage(error) }));
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

export async function handleExport(request: Request): Promise<Response> {
  const body = await readJson<{ dbaUrl?: string }>(request);
  if (!body) return json({ error: "Invalid JSON body" }, 400);
  const dbaUrl = normalizeDbaUrl(body.dbaUrl ?? "");
  if (!dbaUrl) return json({ error: "A valid https://www.dba.dk search URL is required" }, 400);

  const { listings, total } = await fetchAllListings(dbaUrl);
  if (listings.length === 0) return json({ error: "No listings found. The URL may not be a DBA search page." }, 400);
  return json({ url: dbaUrl, exportedAt: new Date().toISOString(), total, listings });
}

export async function doRecurring(env: Env): Promise<void> {
  const list = await getRecurring(env);
  const now = Date.now();
  let changed = false;

  for (const search of list) {
    const interval = INTERVAL_MS[search.interval] ?? INTERVAL_MS.daily;
    if (search.lastRun && now - search.lastRun < interval) continue;
    try {
      const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
      const { listings, total } = await fetchAllListings(search.url);
      const response = listings.length > 0
        ? await client.messages.create({
            model: search.model,
            max_tokens: 4096,
            system: SYSTEM_PROMPT,
            messages: [{ role: "user", content: `${search.prompt}\n\n--- DBA LISTINGS ---\n${listingsBlock(search.url, total, listings)}` }],
          })
        : await client.messages.create({
            model: search.model,
            max_tokens: 4096,
            system: SYSTEM_PROMPT,
            tools: [
              { type: "web_fetch_20260209", name: "web_fetch", allowed_callers: ["direct"] },
              { type: "web_search_20260209", name: "web_search", allowed_callers: ["direct"] },
            ],
            messages: [{ role: "user", content: `Fetch and analyze the DBA.dk listings at:\n${search.url}\n\n${search.prompt}` }],
          } as never);
      search.lastResult = response.content
        .map(block => block.type === "text" ? block.text : "")
        .filter(Boolean)
        .join("\n")
        .slice(0, 8000);
      search.lastRun = now;
      changed = true;
    } catch (error) {
      console.error(JSON.stringify({ event: "recurring_search_failed", searchId: search.id, error: errorMessage(error) }));
    }
  }
  if (changed) await saveRecurring(env, list);
}

export function createRecurringSearch(input: Partial<RecurringSearch>, url: string): RecurringSearch {
  return {
    id: crypto.randomUUID(),
    name: (input.name ?? "").trim() || "Unnamed search",
    url,
    prompt: input.prompt ?? "",
    model: normalizeModel(input.model),
    interval: input.interval === "weekly" ? "weekly" : "daily",
  };
}
