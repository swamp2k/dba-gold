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

function assetRequest(request: Request, pathname: string): Request {
  const url = new URL(request.url);
  url.pathname = pathname;
  url.search = "";
  return new Request(url.toString(), request);
}

async function transformHtml(response: Response, transform: (html: string) => string): Promise<Response> {
  if (!response.ok) return response;
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("text/html")) return response;

  const headers = new Headers(response.headers);
  headers.delete("content-length");
  return new Response(transform(await response.text()), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function serveManualPage(request: Request, env: Env): Promise<Response> {
  // Fetch the root asset directly. Asking the asset binding for /index.html can
  // canonicalize to /, which is now handled by the Worker as Smart Search.
  const response = await env.ASSETS.fetch(assetRequest(request, "/"));
  if (request.method === "HEAD") return response;

  return transformHtml(response, html => {
    const marker = '<div class="tagline">AI-powered DBA.dk listing analyzer</div>';
    const smartLink = '<a class="logout-btn" href="/">✨ Smart Search</a>';
    let integrated = html.includes(marker) && !html.includes('href="/">✨ Smart Search</a>')
      ? html.replace(marker, `${marker}\n    ${smartLink}`)
      : html;

    integrated = integrated.replace(
      '\n            <option value="claude-opus-4-8">Opus 4.8 — Most capable</option>',
      "",
    );
    return integrated;
  });
}

const SMART_HISTORY_CSS = `
    .smart-history-list { display:flex; flex-direction:column; gap:.5rem; }
    .smart-history-row { background:var(--input-bg); border:1px solid var(--border); border-radius:9px; padding:.75rem .9rem; }
    .smart-history-request { color:var(--text); font-size:.88rem; line-height:1.45; }
    .smart-history-meta { color:var(--muted); font-size:.74rem; margin-top:.28rem; }
    .smart-history-actions { display:flex; flex-wrap:wrap; gap:.4rem; margin-top:.6rem; }
    .smart-history-btn { background:none; border:1px solid var(--border); border-radius:6px; color:var(--muted); padding:.28rem .62rem; font:inherit; font-size:.76rem; cursor:pointer; }
    .smart-history-btn:hover { border-color:var(--gold); color:var(--gold); }
    .smart-history-btn.danger:hover { border-color:var(--red); color:var(--red); }
    .smart-history-empty { color:var(--muted); font-size:.86rem; font-style:italic; }
`;

const SMART_HISTORY_HTML = `
    <div class="card">
      <div class="head"><div class="title">Search history</div></div>
      <div class="smart-history-list" id="smartHistory"><span class="smart-history-empty">Loading…</span></div>
    </div>
`;

const SMART_HISTORY_SCRIPT = `
<script>
(() => {
  let smartHistoryEntries = [];
  const prefix = '[Smart Search] ';

  function smartModelLabel(model) {
    if (model === 'claude-sonnet-4-6') return 'Sonnet 4.6';
    if (model === 'claude-opus-4-8') return 'Opus 4.8 (legacy)';
    return 'Haiku 4.5';
  }

  function smartRelativeTime(ts) {
    const diff = Date.now() - ts;
    if (diff < 60000) return 'just now';
    if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
    if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago';
    return Math.floor(diff / 86400000) + 'd ago';
  }

  function smartRequest(entry) {
    return (entry.prompt || '').startsWith(prefix) ? entry.prompt.slice(prefix.length) : (entry.prompt || '');
  }

  function escapeSmartHtml(value) {
    return String(value || '').replace(/[&<>\"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;'}[c]));
  }

  async function loadSmartHistory() {
    const container = document.getElementById('smartHistory');
    if (!container) return;
    try {
      const res = await fetch('/api/history', { headers: { 'Content-Type': 'application/json' } });
      if (!res.ok) throw new Error('History request failed');
      smartHistoryEntries = (await res.json()).filter(e => (e.prompt || '').startsWith(prefix));
      if (!smartHistoryEntries.length) {
        container.innerHTML = '<span class="smart-history-empty">No Smart Searches yet.</span>';
        return;
      }
      container.innerHTML = smartHistoryEntries.map(e => {
        const req = escapeSmartHtml(smartRequest(e));
        return '<div class="smart-history-row">' +
          '<div class="smart-history-request">' + req + '</div>' +
          '<div class="smart-history-meta">' + smartRelativeTime(e.timestamp) + ' · ' + smartModelLabel(e.model) + '</div>' +
          '<div class="smart-history-actions">' +
            (e.result ? '<button class="smart-history-btn" data-smart-view="' + e.id + '">👁 View</button><button class="smart-history-btn" data-smart-export="' + e.id + '">⬇ .md</button>' : '') +
            '<button class="smart-history-btn" data-smart-load="' + e.id + '">▶ Load</button>' +
            '<button class="smart-history-btn danger" data-smart-delete="' + e.id + '">×</button>' +
          '</div></div>';
      }).join('');
    } catch {
      container.innerHTML = '<span class="smart-history-empty">Unable to load history.</span>';
    }
  }

  function findSmartHistory(id) { return smartHistoryEntries.find(e => e.id === id); }

  function loadSmartEntry(entry) {
    if (!entry) return;
    requestEl.value = smartRequest(entry);
    modelEl.value = entry.model === 'claude-sonnet-4-6' ? entry.model : 'claude-haiku-4-5-20251001';
    window.scrollTo({ top: 0, behavior: 'smooth' });
    requestEl.focus();
  }

  function viewSmartEntry(entry) {
    if (!entry || !entry.result) return;
    results.innerHTML = marked.parse(entry.result);
    setStatus('Loaded from history', 'done');
    loadSmartEntry(entry);
  }

  function exportSmartEntry(entry) {
    if (!entry || !entry.result) return;
    const when = new Date(entry.timestamp || Date.now()).toISOString();
    const doc = [
      '# DBA Gold Smart Search', '',
      '- **Request:** ' + smartRequest(entry),
      '- **Model:** ' + smartModelLabel(entry.model),
      '- **Generated:** ' + when, '', '---', '', entry.result, ''
    ].join('\\n');
    const blob = new Blob([doc], { type: 'text/markdown;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'dba-gold-smart-' + when.slice(0,16).replace(/[:T]/g, '-') + '.md';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  document.addEventListener('click', async event => {
    const button = event.target.closest('[data-smart-view],[data-smart-load],[data-smart-export],[data-smart-delete]');
    if (!button) return;
    const id = button.dataset.smartView || button.dataset.smartLoad || button.dataset.smartExport || button.dataset.smartDelete;
    const entry = findSmartHistory(id);
    if (button.dataset.smartView) viewSmartEntry(entry);
    else if (button.dataset.smartLoad) loadSmartEntry(entry);
    else if (button.dataset.smartExport) exportSmartEntry(entry);
    else if (button.dataset.smartDelete) {
      await fetch('/api/history/' + encodeURIComponent(id), { method: 'DELETE', headers: { 'Content-Type': 'application/json' } });
      await loadSmartHistory();
    }
  });

  // A completed Smart Search is saved asynchronously by the Worker; refresh
  // shortly after the stream finishes, and also once when the page opens.
  const observer = new MutationObserver(() => {
    if (badge.textContent === 'Done') setTimeout(loadSmartHistory, 600);
  });
  observer.observe(badge, { childList: true, characterData: true, subtree: true });
  loadSmartHistory();
})();
</script>
`;

async function serveSmartPage(request: Request, env: Env): Promise<Response> {
  const response = await env.ASSETS.fetch(assetRequest(request, "/smart.html"));
  if (request.method === "HEAD") return response;

  return transformHtml(response, html => {
    let integrated = html;
    if (!integrated.includes(".smart-history-list")) {
      integrated = integrated.replace("</style>", `${SMART_HISTORY_CSS}\n  </style>`);
    }
    if (!integrated.includes('id="smartHistory"')) {
      integrated = integrated.replace("  </main>", `${SMART_HISTORY_HTML}\n  </main>`);
    }
    if (!integrated.includes("smartHistoryEntries")) {
      integrated = integrated.replace("</body>", `${SMART_HISTORY_SCRIPT}\n</body>`);
    }
    return integrated;
  });
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

    if ((request.method === "GET" || request.method === "HEAD") && (pathname === "/" || pathname === "/index.html" || pathname === "/smart.html")) {
      return serveSmartPage(request, env);
    }

    if ((request.method === "GET" || request.method === "HEAD") && pathname === "/manual.html") {
      return serveManualPage(request, env);
    }

    return env.ASSETS.fetch(request);
  },

  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(Promise.all([doRecurring(env), doWatchProfiles(env)]).then(() => undefined));
  },
};
