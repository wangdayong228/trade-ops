import assert from 'node:assert/strict';
import test from 'node:test';
import { resolve } from 'node:path';
import { fundingTaskFailure } from '../../src/storage/funding-rate-repository.js';
import {
  runtimeStatusFixture, STATUS_HEADERS, STATUS_SECRET, STATUS_TIME
} from '../support/runtime-status-fixture.js';

const market = { exchangeId: 'okx', exchangeMarketId: 'BTC-USDT-SWAP', symbol: 'BTC/USDT:USDT' } as const;
const request = { method: 'GET', path: '/api/v5/public/instruments', query: { instType: 'SWAP' }, body: null } as const;

test('live responds without database access; ready follows start and the start of shutdown', async (t) => {
  let release!: () => void;
  const fixture = runtimeStatusFixture({ stopGate: new Promise<void>((resolve) => { release = resolve; }) });
  t.after(async () => { release(); await fixture.close(); });
  const server = fixture.composition.server;
  const get = (url: string) => server.inject({ url, headers: STATUS_HEADERS });
  assert.equal((await get('/health/live')).statusCode, 200);
  const starting = await get('/health/ready');
  assert.equal(starting.statusCode, 503);
  assert.equal(starting.json().service.phase, 'STARTING');
  const started = await fixture.start();
  assert.equal((await get('/health/ready')).statusCode, 200);
  const shutdown = started.shutdown();
  const stopping = await get('/health/ready');
  assert.equal(stopping.statusCode, 503);
  assert.equal(stopping.json().service.phase, 'STOPPING');
  assert.equal((await get('/health/live')).statusCode, 200);
  release();
  await shutdown;
  for (const source of fixture.sources) assert.equal(source.operationCalls.length, 0);
});

test('empty state says no discovery has completed, keeps cache disabled and performs no writes', async (t) => {
  const fixture = runtimeStatusFixture();
  t.after(fixture.close);
  const before = fixture.database.prepare('SELECT total_changes() AS count').get();
  const response = await fixture.composition.server.inject({ url: '/api/status', headers: STATUS_HEADERS });
  assert.equal(response.statusCode, 200);
  assert.match(response.headers['cache-control'] ?? '', /no-store/);
  const data = response.json();
  assert.equal(data.generatedAt, new Date(STATUS_TIME).toISOString());
  assert.equal(data.funding.status, 'NOT_STARTED');
  assert.equal(data.funding.intervalMs, 3_600_000);
  assert.equal(data.funding.exchanges.length, 2);
  for (const exchange of data.funding.exchanges) {
    assert.equal(exchange.discovery.status, 'NEVER');
    assert.equal(exchange.discovery.lastSuccessAt, null);
    assert.equal(exchange.counts.total, 0);
    assert.deepEqual(exchange.markets, []);
  }
  assert.deepEqual(fixture.database.prepare('SELECT total_changes() AS count').get(), before);
  for (const source of fixture.sources) assert.equal(source.operationCalls.length, 0);
});

test('persisted interrupted coverage stays separate from current process and incremental status', async (t) => {
  const fixture = runtimeStatusFixture();
  t.after(fixture.close);
  fixture.repository.applyCompleteDiscovery('okx', [{ ...market, active: true }], new Date(STATUS_TIME));
  fixture.repository.startCoverage(market, 'INITIAL', STATUS_TIME, new Date(STATUS_TIME));
  let response = await fixture.composition.server.inject({ url: '/api/status', headers: STATUS_HEADERS });
  assert.equal(response.statusCode, 200);
  let exchange = response.json().funding.exchanges[1];
  assert.equal(exchange.discovery.status, 'NEVER');
  assert.equal(exchange.counts.coverage.BACKFILLING, 1);
  assert.equal(exchange.markets[0].coverageStatus, 'BACKFILLING');
  assert.equal(exchange.markets[0].incrementalStatus, 'IDLE');
  assert.equal(exchange.markets[0].lastCaughtUpCutoffMs, null);
  const lease = fixture.repository.resumeInterruptedCoverage(market, new Date(STATUS_TIME + 1));
  fixture.repository.failCoverage(lease, fundingTaskFailure('SOURCE_RESPONSE_INVALID'), new Date(STATUS_TIME + 2));
  response = await fixture.composition.server.inject({ url: '/api/status', headers: STATUS_HEADERS });
  exchange = response.json().funding.exchanges[1];
  assert.equal(exchange.counts.coverage.INCOMPLETE, 1);
  assert.equal(exchange.counts.incremental.IDLE, 1);
  assert.equal(exchange.markets[0].coverageErrorCode, 'SOURCE_RESPONSE_INVALID');
  assert.equal(exchange.markets[0].coverageEndedAt, new Date(STATUS_TIME + 2).toISOString());
  assert.equal(Object.hasOwn(exchange.markets[0], 'lastExhaustionEvidenceJson'), false);
});

test('discovery retains last success across failures, and its error is redacted without losing evidence', async (t) => {
  const forwarded: string[] = [];
  const fixture = runtimeStatusFixture({ sink: { record(event) { forwarded.push(event.event); throw new Error('test log sink failed'); } } });
  t.after(fixture.close);
  fixture.record({ event: 'funding_market_discovery_completed', exchangeId: 'okx', phase: 'test', observedActiveCount: 4, observedInactiveCount: 1, createdActiveCount: 4, becameInactiveCount: 0, reactivatedCount: 0 });
  fixture.advance(1000);
  fixture.record({ event: 'funding_market_discovery_incomplete', exchangeId: 'okx', phase: 'test', request,
    error: new Error(`instruments request rejected: ${STATUS_SECRET}`, { cause: Object.assign(new Error('upstream returned 429'), { status: 429, body: '{"secret":"hidden-test-value","reason":"rate limit"}' }) }) });
  const response = await fixture.composition.server.inject({ url: '/api/status', headers: STATUS_HEADERS });
  assert.equal(response.statusCode, 200);
  const discovery = response.json().funding.exchanges[1].discovery;
  assert.equal(discovery.status, 'INCOMPLETE');
  assert.equal(discovery.lastSuccessAt, new Date(STATUS_TIME).toISOString());
  assert.equal(discovery.lastAttemptAt, new Date(STATUS_TIME + 1000).toISOString());
  assert.equal(discovery.error.cause.status, 429);
  assert.match(discovery.error.cause.body, /rate limit/);
  assert.doesNotMatch(response.body, new RegExp(`${STATUS_SECRET}|hidden-test-value|"stack"`));
  assert.deepEqual(forwarded, ['funding_market_discovery_completed', 'funding_market_discovery_incomplete']);
  fixture.record({ event: 'funding_market_discovery_completed', exchangeId: 'okx', phase: 'test', observedActiveCount: 2, observedInactiveCount: 0, createdActiveCount: 0, becameInactiveCount: 0, reactivatedCount: 0 });
  const recovered = (await fixture.composition.server.inject({ url: '/api/status', headers: STATUS_HEADERS })).json().funding.exchanges[1].discovery;
  assert.equal(recovered.status, 'SUCCEEDED');
  assert.equal(recovered.error, null);
  assert.equal(recovered.lastSuccessAt, new Date(STATUS_TIME + 1000).toISOString());
});

test('funding fatal survives stopped event and does not make the trading HTTP service unready', async (t) => {
  const fixture = runtimeStatusFixture();
  const started = await fixture.start();
  t.after(started.shutdown);
  fixture.record({ event: 'funding_sync_fatal', phase: 'worker-root', error: new Error(`database write failed: ${STATUS_SECRET}`) });
  fixture.record({ event: 'funding_sync_stopped', phase: 'service-stop' });
  const response = await fixture.composition.server.inject({ url: '/api/status', headers: STATUS_HEADERS });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().funding.status, 'FAILED');
  assert.equal(response.json().funding.lastFatal.at, new Date(STATUS_TIME).toISOString());
  assert.match(response.json().funding.lastFatal.error.message, /database write failed/);
  assert.doesNotMatch(response.body, new RegExp(STATUS_SECRET));
  assert.equal((await fixture.composition.server.inject({ url: '/health/ready', headers: STATUS_HEADERS })).statusCode, 200);
});

test('database failure is visible while live remains available, and state corruption cannot masquerade as an empty list', async (t) => {
  const fixture = runtimeStatusFixture();
  t.after(fixture.close);
  fixture.repository.listMarketStates = () => { throw new Error('funding state invalid: expected valid coverage status; actual CORRUPT'); };
  const failed = await fixture.composition.server.inject({ url: '/api/status', headers: STATUS_HEADERS });
  assert.equal(failed.statusCode, 500);
  assert.match(failed.body, /CORRUPT/);
  fixture.database.close();
  assert.equal((await fixture.composition.server.inject({ url: '/health/live', headers: STATUS_HEADERS })).statusCode, 200);
  const ready = await fixture.composition.server.inject({ url: '/health/ready', headers: STATUS_HEADERS });
  assert.equal(ready.statusCode, 503);
  assert.equal(ready.json().database.status, 'error');
  assert.match(ready.json().database.error.message, /not open|closed/);
});

test('new status and health routes retain the local Host boundary and no-store headers', async (t) => {
  const fixture = runtimeStatusFixture();
  t.after(fixture.close);
  for (const url of ['/api/status', '/health/live', '/health/ready']) {
    assert.equal((await fixture.composition.server.inject({ url, headers: { host: 'evil.example' } })).statusCode, 403);
    const local = await fixture.composition.server.inject({ url, headers: STATUS_HEADERS });
    assert.match(local.headers['cache-control'] ?? '', /no-store/);
    assert.match(local.headers['content-security-policy'] ?? '', /script-src 'self'/);
  }
});

test('short database filenames cannot redact market identities or diagnostic words', async (t) => {
  const fixture = runtimeStatusFixture({ databasePath: 'a' });
  t.after(fixture.close);
  fixture.repository.applyCompleteDiscovery('okx', [{ ...market, exchangeMarketId: 'a-USDT-SWAP', symbol: 'a/USDT:USDT', active: true }], new Date(STATUS_TIME));
  const response = await fixture.composition.server.inject({ url: '/api/status', headers: STATUS_HEADERS });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().funding.exchanges[1].markets[0].symbol, 'a/USDT:USDT');
  assert.equal(Object.hasOwn(response.json().service, 'databasePath'), false);
  fixture.database.prepare = () => { throw new Error('database access failed at a'); };
  const ready = await fixture.composition.server.inject({ url: '/health/ready', headers: STATUS_HEADERS });
  assert.equal(ready.json().database.error.message, 'database access failed at a');
});

test('file path diagnostic evidence remains intact while credentials and stacks stay private', async (t) => {
  const databasePath = 'api';
  const fixture = runtimeStatusFixture({ databasePath });
  t.after(fixture.close);
  const failRead = (): never => { throw new Error(`GET /api/status: SQLite read failed at ${databasePath}; resolved path ${resolve(databasePath)}; ${STATUS_SECRET}`); };
  fixture.database.prepare = failRead;
  fixture.repository.listMarketStates = failRead;
  for (const url of ['/health/ready', '/api/status']) {
    const response = await fixture.composition.server.inject({ url, headers: STATUS_HEADERS });
    assert.equal(response.statusCode, url === '/api/status' ? 500 : 503);
    assert.match(response.body, /GET \/api\/status/);
    assert.ok(response.body.includes(resolve(databasePath)));
    assert.doesNotMatch(response.body, new RegExp(STATUS_SECRET));
    assert.doesNotMatch(response.body, /"stack"/);
  }
});

test('service uptime starts only after listening completes', async (t) => {
  let release!: () => void;
  const fixture = runtimeStatusFixture({ listenGate: new Promise<void>((resolve) => { release = resolve; }) });
  t.after(async () => { release(); await fixture.close(); });
  fixture.advance(20_000);
  const starting = fixture.start();
  await fixture.composition.server.ready();
  fixture.advance(15_000);
  const before = (await fixture.composition.server.inject({ url: '/api/status', headers: STATUS_HEADERS })).json();
  assert.equal(before.service.startedAt, null);
  assert.equal(before.service.uptimeMs, 0);
  release();
  const started = await starting;
  fixture.advance(2000);
  const running = (await fixture.composition.server.inject({ url: '/api/status', headers: STATUS_HEADERS })).json();
  assert.equal(running.service.startedAt, new Date(STATUS_TIME + 35_000).toISOString());
  assert.equal(running.service.uptimeMs, 2000);
  await started.shutdown();
});

test('incremental running and failure stay independent of successful coverage and its cutoff', async (t) => {
  const fixture = runtimeStatusFixture();
  t.after(fixture.close);
  fixture.repository.applyCompleteDiscovery('okx', [{ ...market, active: true }], new Date(STATUS_TIME));
  const coverage = fixture.repository.startCoverage(market, 'INITIAL', STATUS_TIME, new Date(STATUS_TIME));
  fixture.repository.completeCoverage(coverage, { exchangeId: 'okx', generation: coverage.generation, cutoffMs: STATUS_TIME, explicitEmpty: true, finalRequestAfterMs: null }, new Date(STATUS_TIME));
  const incremental = fixture.repository.startIncremental(market, new Date(STATUS_TIME + 1));
  const read = async () => (await fixture.composition.server.inject({ url: '/api/status', headers: STATUS_HEADERS })).json().funding.exchanges[1];
  const running = await read();
  assert.equal(running.counts.coverage.CAUGHT_UP, 1);
  assert.equal(running.counts.incremental.RUNNING, 1);
  assert.equal(running.markets[0].incrementalStatus, 'RUNNING');
  fixture.repository.failIncremental(incremental, fundingTaskFailure('REQUEST_RETRY_EXHAUSTED'), new Date(STATUS_TIME + 2));
  const failed = await read();
  assert.equal(failed.counts.coverage.CAUGHT_UP, 1);
  assert.equal(failed.counts.incremental.INCOMPLETE, 1);
  assert.equal(failed.markets[0].incrementalStatus, 'INCOMPLETE');
  assert.equal(failed.markets[0].incrementalErrorCode, 'REQUEST_RETRY_EXHAUSTED');
  assert.equal(failed.markets[0].incrementalEndedAt, new Date(STATUS_TIME + 2).toISOString());
  assert.equal(failed.markets[0].coverageErrorCode, null);
  assert.equal(failed.markets[0].coverageLastSuccessAt, new Date(STATUS_TIME).toISOString());
  assert.equal(failed.markets[0].lastCaughtUpCutoffMs, STATUS_TIME);
});
