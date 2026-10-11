import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { test } from 'node:test';

function load(fetch, reply = '[]') {
  const context = vm.createContext({
    fetch, AbortSignal, TextDecoder, Response, Request, URL, Set, Map,
    MAX_DBA_PAGE_BYTES: 2000000, MAX_PAGES: 40, DBA_ITEM_BASE: 'https://www.dba.dk/recommerce/forsale/item/',
    normalizeDbaUrl: raw => { try { const u = new URL(raw); return u.protocol === 'https:' && ['www.dba.dk', 'dba.dk'].includes(u.hostname) ? u.href : null; } catch { return null; } },
    normalizeModel: () => 'test-model', errorMessage: e => e.message,
    json: (data, status = 200) => Response.json(data, { status }),
    Anthropic: class { messages = { create: async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: reply }] }) }; },
  });
  for (const path of ['src/dba.ts', 'src/extract.ts']) {
    const code = readFileSync(new URL('../' + path, import.meta.url), 'utf8')
      .replace(/^import[\s\S]*?;\s*/gm, '').replace(/^export /gm, '');
    vm.runInContext(stripTypeScriptTypes(code), context);
  }
  return context;
}
function html(data) { return `<script type="application/ld+json">${JSON.stringify(data)}</script>`; }
function request(body) { return new Request('https://app/api/extract', { method: 'POST', body: JSON.stringify(body) }); }

test('preserves nested Product facts without invented fields', () => {
  const c = load();
  const product = { '@type': 'Product', name: 'iPhone 15', description: '128GB', image: ['photo'], additionalProperty: [{ name: 'Condition', value: 'Used' }] };
  assert.deepEqual(JSON.parse(JSON.stringify(c.parseDetails(html({ '@graph': [product] })))), product);
  assert.equal(c.parseDetails(html({ '@type': 'WebPage' })), null);
  assert.equal(c.parseDetails('<script type="application/ld+json">invalid</script>'), null);
});
test('selection rejects invented IDs and malformed output', () => {
  const c = load();
  assert.equal(c.validateSelection('["12"]', ['12']).has('12'), true);
  assert.throws(() => c.validateSelection('["99"]', ['12']));
  assert.throws(() => c.validateSelection('```json\n[]\n```', ['12']));
});
test('search page parses summaries and pagination total', async () => {
  const c = load(async url => {
    assert.equal(new URL(url).searchParams.get('page'), '2');
    return new Response('1.234 annoncer' + html({ '@type': 'CollectionPage', mainEntity: { '@type': 'ItemList', itemListElement: [{ item: { name: 'iPhone', url: 'https://www.dba.dk/recommerce/forsale/item/12', offers: { price: '3000', priceCurrency: 'DKK' } } }] } }));
  });
  const res = await c.handleExtract(request({ action: 'page', dbaUrl: 'https://www.dba.dk/search', page: 2 }), {});
  const data = await res.json();
  assert.equal(data.total, 1234);
  assert.equal(data.listings[0].price, 3000);
});
test('details select matching IDs and report failed fetches', async () => {
  const c = load(async url => url.endsWith('/13') ? new Response('', { status: 404 }) : new Response(html({ '@type': 'Product', name: url.endsWith('/12') ? 'iPhone 15' : 'iPhone case' })), '["12"]');
  const res = await c.handleExtract(request({ action: 'details', ids: ['12', '13', '14'], criteria: 'iPhones only' }), { ANTHROPIC_API_KEY: 'test' });
  const data = await res.json();
  assert.deepEqual(data.listings.map(x => x.id), ['12']);
  assert.deepEqual(data.failures.map(x => x.id), ['13']);
});
test('blank criteria keeps failed listings and never calls AI', async () => {
  const c = load(async () => new Response('', { status: 403 }), 'invalid');
  const res = await c.handleExtract(request({ action: 'details', ids: ['12'], criteria: '' }), {});
  assert.equal((await res.json()).listings[0].detailStatus, 'failed');
});
test('rejects invalid inputs and blocked or oversized pages', async () => {
  const c = load(async () => new Response('blocked'));
  assert.equal((await c.handleExtract(request({ action: 'page', dbaUrl: 'https://evil.example', page: 1 }), {})).status, 400);
  assert.equal((await c.handleExtract(request({ action: 'details', ids: ['../secrets'], criteria: '' }), {})).status, 400);
  assert.equal((await c.handleExtract(request({ action: 'page', dbaUrl: 'https://www.dba.dk/search', page: 1 }), {})).status, 502);
  const big = load(async () => new Response('x'.repeat(2000001)));
  assert.equal((await big.handleExtract(request({ action: 'page', dbaUrl: 'https://www.dba.dk/search', page: 1 }), {})).status, 502);
});
test('frontend script is syntactically valid', () => {
  const page = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  for (const match of page.matchAll(/<script>([\s\S]*?)<\/script>/g)) new vm.Script(match[1]);
});

test('frontend orchestrates pages and batches into downloadable JSON', async () => {
  const elements = new Map(['url', 'extractCriteria', 'model', 'exportBtn', 'extractStatus', 'extractCancel'].map(id => [id, { value: '', hidden: false }]));
  elements.get('url').value = 'https://www.dba.dk/search';
  elements.get('extractCriteria').value = 'iPhones only';
  elements.get('model').value = 'selected-model';
  let downloaded, downloadName;
  const calls = [];
  const sandbox = {
    window: { addEventListener() {} }, document: {
      addEventListener() {}, getElementById: id => elements.get(id),
      body: { appendChild() {} }, createElement: () => ({ click() { downloadName = this.download; }, remove() {} }),
    },
    AbortController, Date, Map, Blob, setTimeout: fn => fn(),
    URL: { createObjectURL: blob => { downloaded = blob; return 'blob:test'; }, revokeObjectURL() {} },
    fetch: async (_url, options) => {
      const body = JSON.parse(options.body); calls.push(body);
      if (body.action === 'page') return Response.json({ total: 2, maxPages: 40, listings: [{ id: '12', name: 'iPhone', price: 100 }, { id: '14', name: 'case', price: 20 }] });
      return Response.json({ listings: [{ id: '12', url: 'listing', detailStatus: 'ok', source: { description: '128GB' } }], failures: [] });
    },
  };
  const page = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const context = vm.createContext(sandbox);
  vm.runInContext([...page.matchAll(/<script>([\s\S]*?)<\/script>/g)][0][1], context);
  await vm.runInContext('exportJson()', context);
  const data = JSON.parse(await downloaded.text());
  assert.equal(data.criteria, 'iPhones only');
  assert.equal(data.listings[0].price, 100);
  assert.equal(data.collection.complete, true);
  assert.equal(data.collection.listingsCollected, 2);
  assert.equal(calls[1].criteria, 'iPhones only');
  assert.match(downloadName, /\.json$/);
  assert.equal(elements.get('exportBtn').disabled, false);
});

test('Workers-compatible manual redirects preserve pagination within DBA', async () => {
  const calls = [];
  const c = load(async (url, options) => {
    assert.equal(options.redirect, 'manual');
    calls.push(url);
    if (calls.length === 1) return new Response('', { status: 301, headers: { location: 'https://www.dba.dk/search?page=2' } });
    return new Response(html({ '@type': 'ItemList', itemListElement: [] }));
  });
  const response = await c.handleExtract(request({ action: 'page', dbaUrl: 'https://dba.dk/search', page: 2 }), {});
  assert.equal(response.status, 200);
  assert.equal(calls.length, 2);
  assert.equal(new URL(calls[1]).searchParams.get('page'), '2');
});
test('redirects outside DBA, missing locations and loops fail clearly', async () => {
  for (const location of ['https://evil.example/search', 'http://www.dba.dk/search', 'https://www.dba.dk:8443/search', null, '/search']) {
    let calls = 0;
    const c = load(async (_url, options) => {
      assert.equal(options.redirect, 'manual');
      calls++;
      return new Response('', { status: 302, headers: location ? { location } : {} });
    });
    const response = await c.handleExtract(request({ action: 'page', dbaUrl: 'https://www.dba.dk/search', page: 1 }), {});
    assert.equal(response.status, 502);
    assert.match((await response.json()).error, /redirect/i);
    assert.ok(calls <= 4);
    if (location && !location.startsWith('/')) assert.equal(calls, 1);
  }
});
