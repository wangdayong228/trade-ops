import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { runtimeStatusFixture, STATUS_HEADERS, STATUS_TIME } from '../support/runtime-status-fixture.js';

class Element {
  children: Element[] = [];
  dataset: Record<string, string> = {};
  attributes: Record<string, string> = {};
  listeners = new Map<string, () => unknown>();
  value = '';
  disabled = false;
  className = '';
  private text = '';
  constructor(readonly tagName = 'div') {}
  set textContent(value: string) { this.text = value; this.children = []; }
  get textContent(): string { return this.text + this.children.map((child) => child.textContent).join(' '); }
  append(...values: Element[]) { this.children.push(...values); }
  replaceChildren(...values: Element[]) { this.text = ''; this.children = values; }
  setAttribute(key: string, value: string) { this.attributes[key] = value; }
  addEventListener(event: string, callback: () => unknown) { this.listeners.set(event, callback); }
}

async function browser(snapshot: unknown) {
  const elements = new Map<string, Element>();
  const timers = new Map<number, { callback: () => unknown; ms: number }>();
  const documentEvents = new Map<string, () => unknown>();
  const windowEvents = new Map<string, () => unknown>();
  let nextTimer = 0;
  let calls = 0;
  let fetcher: (url: string, init: { signal: AbortSignal }) => Promise<unknown> = async () => ({ ok: true, status: 200, json: async () => snapshot });
  const document = {
    hidden: false,
    getElementById(id: string) {
      if (!elements.has(id)) elements.set(id, new Element());
      return elements.get(id)!;
    },
    createElement: (tag: string) => new Element(tag),
    createDocumentFragment: () => new Element('fragment'),
    addEventListener: (event: string, callback: () => unknown) => documentEvents.set(event, callback)
  };
  const source = await readFile('public/status.js', 'utf8').catch(() => null);
  assert.notEqual(source, null, 'status page script must exist');
  runInNewContext(source!, {
    document, window: { addEventListener: (event: string, callback: () => unknown) => windowEvents.set(event, callback) },
    fetch: (url: string, init: { signal: AbortSignal }) => { calls += 1; assert.equal(url, '/api/status'); return fetcher(url, init); },
    AbortController, Date, console,
    setTimeout: (callback: () => unknown, ms: number) => { const id = ++nextTimer; timers.set(id, { callback, ms }); return id; },
    clearTimeout: (id: number) => timers.delete(id)
  });
  const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
  await settle();
  return {
    elements, timers, document, documentEvents, windowEvents, settle,
    calls: () => calls,
    text: (id: string) => document.getElementById(id).textContent,
    setFetch: (next: typeof fetcher) => { fetcher = next; },
    click: async () => { await document.getElementById('status-refresh').listeners.get('click')?.(); await settle(); }
  };
}

async function sample() {
  const fixture = runtimeStatusFixture();
  const started = await fixture.start();
  const data = (await fixture.composition.server.inject({ url: '/api/status', headers: STATUS_HEADERS })).json();
  await started.shutdown();
  return data;
}

test('status page is linked from home and served with local scripts and security headers', async (t) => {
  const fixture = runtimeStatusFixture();
  t.after(fixture.close);
  const home = await fixture.composition.server.inject({ url: '/', headers: STATUS_HEADERS });
  assert.match(home.body, /href="\/status.html"/);
  for (const url of ['/status.html', '/status.js', '/status.css']) {
    const response = await fixture.composition.server.inject({ url, headers: STATUS_HEADERS });
    assert.equal(response.statusCode, 200, url);
    assert.match(response.headers['content-security-policy'] ?? '', /script-src 'self'/);
  }
});

test('page distinguishes empty discovery, service health and the funding lifecycle', async () => {
  const page = await browser(await sample());
  assert.match(page.text('service-overview'), /就绪/);
  assert.match(page.text('service-overview'), /运行中/);
  assert.match(page.text('exchange-overview'), /尚无发现结果/);
  assert.match(page.text('market-rows'), /暂无已知市场/);
  assert.equal(page.calls(), 1);
  assert.equal(page.document.getElementById('status-refresh').disabled, false);
  assert.equal(page.timers.size, 1);
  assert.equal([...page.timers.values()][0]?.ms, 10000);
});

test('failed refresh marks the last successful snapshot stale and recovery clears that state', async () => {
  const data = await sample();
  const page = await browser(data);
  page.setFetch(async () => ({ ok: false, status: 500, json: async () => ({ requestId: 'req-test', error: { message: 'funding state invalid: coverageStatus=CORRUPT' } }) }));
  await page.click();
  assert.match(page.text('status-message'), /500.*CORRUPT/s);
  assert.match(page.text('snapshot-age'), /过期/);
  assert.equal(page.document.getElementById('status-content').dataset.stale, 'true');
  page.setFetch(async () => ({ ok: true, status: 200, json: async () => data }));
  await page.click();
  assert.equal(page.document.getElementById('status-content').dataset.stale, 'false');
  assert.doesNotMatch(page.text('snapshot-age'), /过期/);
});

test('invalid successful response cannot replace a known snapshot with a healthy empty state', async () => {
  const page = await browser(await sample());
  page.setFetch(async () => ({ ok: true, status: 200, json: async () => ({ status: 'ready' }) }));
  await page.click();
  assert.match(page.text('status-message'), /service|generatedAt/);
  assert.equal(page.document.getElementById('status-content').dataset.stale, 'true');
});

test('incomplete discovery evidence is text-only and market filtering preserves independent statuses', async (t) => {
  const fixture = runtimeStatusFixture();
  t.after(fixture.close);
  const symbol = '<img src=x onerror=alert(1)>/USDT:USDT';
  fixture.repository.applyCompleteDiscovery('okx', [{ exchangeId: 'okx', exchangeMarketId: 'X-USDT-SWAP', symbol, active: true }], new Date(STATUS_TIME));
  const data = (await fixture.composition.server.inject({ url: '/api/status', headers: STATUS_HEADERS })).json();
  data.funding.exchanges[1].discovery.status = 'INCOMPLETE';
  data.funding.exchanges[1].discovery.lastAttemptAt = new Date(STATUS_TIME).toISOString();
  data.funding.exchanges[1].discovery.error = { type: 'Error', message: '<script>alert(1)</script>' };
  const page = await browser(data);
  assert.match(page.text('market-rows'), /<img src=x onerror=alert\(1\)>/);
  assert.match(page.text('market-rows'), /待回填/);
  assert.match(page.text('market-rows'), /空闲/);
  assert.match(page.text('exchange-overview'), /<script>alert\(1\)<\/script>/);
  const tags = (element: Element): string[] => [element.tagName, ...element.children.flatMap(tags)];
  assert.equal(tags(page.document.getElementById('status-content')).includes('script'), false);
  assert.equal(tags(page.document.getElementById('market-rows')).includes('img'), false);
  const search = page.document.getElementById('market-search');
  search.value = 'nonexistent';
  search.listeners.get('input')?.();
  assert.match(page.text('market-rows'), /没有匹配/);
  search.value = '';
  search.listeners.get('input')?.();
  assert.match(page.text('market-rows'), /X-USDT-SWAP/);
});

test('requests do not overlap, time out visibly, and polling stops when hidden or leaving', async () => {
  const page = await browser(await sample());
  page.setFetch(async (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason))));
  const click = page.document.getElementById('status-refresh').listeners.get('click')!;
  const pending = click();
  await click();
  assert.equal(page.calls(), 2);
  const timeout = [...page.timers.values()][0]!;
  timeout.callback();
  await pending;
  await page.settle();
  assert.match(page.text('status-message'), /10 秒/);
  page.document.hidden = true;
  page.documentEvents.get('visibilitychange')?.();
  assert.equal(page.timers.size, 0);
  page.document.hidden = false;
  page.documentEvents.get('visibilitychange')?.();
  assert.equal(page.calls(), 3);
  page.windowEvents.get('pagehide')?.();
  await page.settle();
  assert.equal(page.timers.size, 0);
});

for (const mode of ['visibility', 'page-lifecycle']) {
  test(`resuming ${mode} during an aborted request refreshes immediately without showing a false failure`, async () => {
    const data = await sample();
    const page = await browser(data);
    let rejectAborted!: () => void;
    page.setFetch(async (_url, { signal }) => new Promise((_resolve, reject) => { rejectAborted = () => reject(signal.reason); }));
    const pending = page.document.getElementById('status-refresh').listeners.get('click')!();
    if (mode === 'visibility') {
      page.document.hidden = true;
      page.documentEvents.get('visibilitychange')?.();
      page.document.hidden = false;
      page.documentEvents.get('visibilitychange')?.();
    } else {
      page.windowEvents.get('pagehide')?.();
      page.windowEvents.get('pageshow')?.();
    }
    page.setFetch(async () => ({ ok: true, status: 200, json: async () => data }));
    rejectAborted();
    await pending;
    await page.settle();
    assert.equal(page.calls(), 3, 'one immediate fresh request must follow the aborted request');
    assert.equal(page.text('status-message'), '');
    assert.equal(page.document.getElementById('status-content').dataset.stale, 'false');
  });
}

test('contradictory success snapshots cannot replace trusted status', async (t) => {
  const base = await sample();
  const cases: Array<[string, (data: any) => void]> = [
    ['active count exceeds total', (data) => { data.funding.exchanges[0].counts.active = 99; }],
    ['coverage count disagrees with markets', (data) => { data.funding.exchanges[0].counts.coverage.CAUGHT_UP = 99; }],
    ['incremental count disagrees with markets', (data) => { data.funding.exchanges[0].counts.incremental.RUNNING = 99; }],
    ['running service lacks start time', (data) => { data.service.startedAt = null; }],
    ['failed funding lacks evidence', (data) => { data.funding.status = 'FAILED'; }],
    ['running funding carries fatal evidence', (data) => { data.funding.lastFatal = { at: data.generatedAt, error: { type: 'Error', message: 'fatal' } }; }],
    ['database failure lacks evidence', (data) => { data.status = 'not_ready'; data.database = { status: 'error' }; }],
    ['discovery failure lacks evidence', (data) => { data.funding.exchanges[0].discovery.status = 'INCOMPLETE'; }]
  ];
  for (const [name, corrupt] of cases) {
    await t.test(name, async () => {
      const page = await browser(base);
      const broken = structuredClone(base);
      corrupt(broken);
      page.setFetch(async () => ({ ok: true, status: 200, json: async () => broken }));
      await page.click();
      assert.equal(page.document.getElementById('status-content').dataset.stale, 'true');
      assert.match(page.text('snapshot-age'), /过期/);
      assert.match(page.text('status-message'), /检查失败/);
    });
  }
});
