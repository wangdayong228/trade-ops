/// <reference types="node" />

import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test, { type TestContext } from 'node:test';
import { runInNewContext } from 'node:vm';
import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { makeClientOrderId } from '../../src/domain/client-order-id.js';
import type {
  OrderRequest,
  OrderRole,
  OrderSnapshot
} from '../../src/domain/types.js';
import { ExchangeRegistry } from '../../src/exchanges/exchange-registry.js';
import {
  buildServer,
  LOGGER_REDACT_PATHS
} from '../../src/http/server.js';
import type {
  OperationalFields,
  OperationalLog
} from '../../src/logging/logger.js';
import { HedgeCoordinator } from '../../src/strategy/hedge-coordinator.js';
import type {
  PreflightInput,
  PreflightResult
} from '../../src/strategy/preflight-service.js';
import { SqliteStrategyRepository } from '../../src/storage/sqlite-strategy-repository.js';
import {
  StrategyNotFoundError,
  type StrategyRepository
} from '../../src/storage/strategy-repository.js';
import { FakeExchangeGateway } from '../support/fake-exchange-gateway.js';

const SYMBOL = 'BTC/USDT';
const LOCAL_HEADERS = {
  host: 'localhost:80',
  origin: 'http://localhost:80'
} as const;

interface CapturedOperationalError {
  readonly event: string;
  readonly error: unknown;
  readonly fields: Readonly<OperationalFields> | undefined;
}

function captureOperationalErrors(
  entries: CapturedOperationalError[]
): OperationalLog {
  return {
    info(): void {},
    error(event, error, fields): void {
      entries.push({ event, error, fields });
    },
    fatal(): void {}
  };
}

function assertPublicHttpError(
  response: { json(): Record<string, unknown> },
  expected: Readonly<Record<string, unknown>>
): void {
  const body = response.json();
  assert.equal(typeof body.requestId, 'string');
  assert.deepEqual(body, {
    ...expected,
    requestId: body.requestId
  });
}

function preflight(
  overrides: Partial<PreflightResult> = {}
): PreflightResult {
  return {
    spotExchangeId: 'bitget',
    contractExchangeId: 'okx',
    symbol: SYMBOL,
    requestedBaseQuantity: '1',
    effectiveBaseQuantity: '1',
    mode: 'CONTRACT_FIRST',
    spotMarket: {
      exchangeId: 'bitget',
      symbol: SYMBOL,
      marketId: 'BTCUSDT',
      kind: 'spot',
      base: 'BTC',
      quote: 'USDT',
      active: true,
      amountStep: '0.001',
      contractSize: '1',
      minBaseAmount: '0.001',
      minQuoteNotional: '5',
      priceStep: '0.1'
    },
    contractMarket: {
      exchangeId: 'okx',
      symbol: SYMBOL,
      marketId: 'BTC-USDT-SWAP',
      kind: 'swap',
      base: 'BTC',
      quote: 'USDT',
      active: true,
      amountStep: '1',
      contractSize: '0.001',
      minBaseAmount: '0.001',
      minQuoteNotional: '5',
      priceStep: '0.1'
    },
    accountSettings: {
      marginMode: 'isolated',
      positionMode: 'hedged',
      leverage: '2'
    },
    spotFreeUsdt: '100000',
    contractFreeUsdt: '50000',
    spotReferencePrice: '60000',
    contractReferencePrice: '60010',
    riskAcknowledgementRequired: true,
    createdAt: '2026-07-31T00:00:00.000Z',
    ...overrides
  };
}

interface Fixture {
  readonly server: FastifyInstance;
  readonly repository: SqliteStrategyRepository;
  readonly preflightInputs: PreflightInput[];
  readonly getExecutionCount: () => number;
}

function setup(
  t: TestContext,
  options: {
    readonly repository?: StrategyRepository;
    readonly runPreflight?: (
      input: PreflightInput
    ) => Promise<PreflightResult>;
    readonly confirmAndExecute?: (strategyId: string) => Promise<void>;
    readonly operationalLog?: OperationalLog;
    readonly secretProvider?: () => readonly string[];
  } = {}
): Fixture {
  const database = new Database(':memory:');
  const baseRepository = new SqliteStrategyRepository(database);
  const repository = options.repository ?? baseRepository;
  const preflightInputs: PreflightInput[] = [];
  let executionCount = 0;
  const server = buildServer({
    registry: {
      ids: () => ['bitget', 'okx']
    },
    preflightService: {
      run: async (input) => {
        preflightInputs.push(input);
        return options.runPreflight?.(input) ?? preflight(input);
      }
    },
    repository,
    coordinator: {
      confirmAndExecute: async (strategyId) => {
        executionCount += 1;
        await options.confirmAndExecute?.(strategyId);
      }
    },
    ...(options.operationalLog === undefined
      ? {}
      : { operationalLog: options.operationalLog }),
    ...(options.secretProvider === undefined
      ? {}
      : { secretProvider: options.secretProvider }),
    logger: false
  });
  t.after(async () => {
    await server.close();
    database.close();
  });
  return {
    server,
    repository: baseRepository,
    preflightInputs,
    getExecutionCount: () => executionCount
  };
}

function requestFor(
  strategyId: string,
  role: OrderRole,
  baseQuantity: string
): OrderRequest {
  const common = {
    symbol: SYMBOL,
    baseQuantity,
    clientOrderId: makeClientOrderId(strategyId, role)
  };
  switch (role) {
    case 'SPOT_MARKET':
      return {
        ...common,
        kind: 'spot',
        type: 'market',
        side: 'buy'
      };
    case 'CONTRACT_MARKET':
      return {
        ...common,
        kind: 'swap',
        type: 'market',
        side: 'sell',
        positionSide: 'SHORT',
        marginMode: 'isolated'
      };
    case 'SPOT_HEDGE_GTC':
      return {
        ...common,
        kind: 'spot',
        type: 'limit',
        side: 'buy',
        price: '60000',
        timeInForce: 'GTC'
      };
    case 'CONTRACT_HEDGE_GTC':
      return {
        ...common,
        kind: 'swap',
        type: 'limit',
        side: 'sell',
        price: '60000',
        timeInForce: 'GTC',
        positionSide: 'SHORT',
        marginMode: 'isolated'
      };
  }
}

function snapshotFor(
  request: OrderRequest,
  exchangeId: string,
  overrides: Partial<OrderSnapshot> = {}
): OrderSnapshot {
  return {
    exchangeId,
    exchangeOrderId: `${exchangeId}-${request.clientOrderId}`,
    clientOrderId: request.clientOrderId,
    symbol: request.symbol,
    kind: request.kind,
    type: request.type,
    side: request.side,
    requestedBaseQuantity: request.baseQuantity,
    filledBaseQuantity: '0',
    remainingBaseQuantity: request.baseQuantity,
    averagePrice: null,
    status: 'open',
    updatedAt: '2026-07-31T00:01:00.000Z',
    ...overrides
  };
}

async function flushImmediate(): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

type BrowserListener = (event: {
  preventDefault(): void;
}) => unknown;

class FakeBrowserElement {
  value = '';
  checked = false;
  disabled = false;
  textContent = '';
  readonly dataset: Record<string, string> = {};
  readonly children: FakeBrowserElement[] = [];
  readonly #listeners = new Map<string, BrowserListener[]>();

  addEventListener(type: string, listener: BrowserListener): void {
    const listeners = this.#listeners.get(type) ?? [];
    listeners.push(listener);
    this.#listeners.set(type, listeners);
  }

  append(child: FakeBrowserElement): void {
    this.children.push(child);
  }

  replaceChildren(...children: FakeBrowserElement[]): void {
    this.children.splice(0, this.children.length, ...children);
  }

  reportValidity(): boolean {
    return true;
  }

  async emit(type: string): Promise<void> {
    const event = { preventDefault(): void {} };
    for (const listener of this.#listeners.get(type) ?? []) {
      await listener(event);
    }
  }
}

interface FakeBrowserResponse {
  readonly status: number;
  readonly ok: boolean;
  json(): Promise<unknown>;
}

type BrowserFetch = (
  url: string,
  options?: Record<string, unknown>
) => Promise<FakeBrowserResponse>;

interface BrowserHarness {
  readonly fetchCalls: Array<{
    readonly url: string;
    readonly options: Record<string, unknown> | undefined;
  }>;
  element(id: string): FakeBrowserElement;
  setFetch(fetch: BrowserFetch): void;
}

function browserResponse(
  status: number,
  body: unknown = null
): FakeBrowserResponse {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body
  };
}

function browserPreflightResponse(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    id: 'strategy-browser-1',
    state: 'PENDING_CONFIRMATION',
    preflight: {
      spotExchangeId: 'bitget',
      contractExchangeId: 'okx',
      symbol: SYMBOL,
      requestedBaseQuantity: '1',
      mode: 'CONCURRENT',
      effectiveBaseQuantity: '1',
      spotReferencePrice: '60000',
      contractReferencePrice: '60010',
      spotFreeUsdt: '100000',
      contractFreeUsdt: '50000',
      riskAcknowledgementRequired: true,
      accountSettings: {
        marginMode: 'isolated',
        positionMode: 'hedged',
        leverage: '2'
      },
      spotMarket: {
        exchangeId: 'bitget',
        symbol: SYMBOL,
        marketId: 'BTCUSDT',
        kind: 'spot',
        base: 'BTC',
        quote: 'USDT',
        active: true,
        amountStep: '0.001',
        contractSize: '1',
        minBaseAmount: '0.001',
        minQuoteNotional: '5',
        priceStep: '0.1'
      },
      contractMarket: {
        exchangeId: 'okx',
        symbol: SYMBOL,
        marketId: 'BTC-USDT-SWAP',
        kind: 'swap',
        base: 'BTC',
        quote: 'USDT',
        active: true,
        amountStep: '1',
        contractSize: '0.001',
        minBaseAmount: '0.001',
        minQuoteNotional: '5',
        priceStep: '0.1'
      },
      createdAt: '2026-07-31T00:00:00.000Z'
    },
    ...overrides
  };
}

function browserOrderResponse(
  strategyId: string,
  role: OrderRole = 'SPOT_MARKET',
  orderId = '223e4567-e89b-42d3-a456-426614174000',
  baseQuantity = '1'
): Record<string, unknown> {
  const request = requestFor(strategyId, role, baseQuantity);
  const exchangeId = role.startsWith('SPOT_') ? 'bitget' : 'okx';
  const snapshot = snapshotFor(request, exchangeId);
  return {
    id: orderId,
    strategyId,
    role,
    exchangeId,
    clientOrderId: request.clientOrderId,
    exchangeOrderId: snapshot.exchangeOrderId,
    request,
    snapshot,
    status: snapshot.status,
    createdAt: '2026-07-31T00:01:00.000Z',
    updatedAt: '2026-07-31T00:01:00.000Z'
  };
}

function setBrowserOrderSnapshot(
  order: Record<string, unknown>,
  overrides: Partial<OrderSnapshot>
): void {
  Object.assign(order.snapshot as Record<string, unknown>, overrides);
  if (overrides.status !== undefined) {
    order.status = overrides.status;
  }
}

function setBrowserActualFills(
  body: Record<string, unknown>,
  spotBuyBaseQuantity: string,
  contractShortBaseQuantity: string,
  unmatchedBaseQuantity: string
): void {
  body.actualFills = {
    spotBuyBaseQuantity,
    contractShortBaseQuantity,
    unmatchedBaseQuantity
  };
}

function browserStatusResponse(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  const preflight = browserPreflightResponse().preflight;
  return {
    strategy: {
      id: 'strategy-browser-1',
      state: 'EXECUTING',
      spotExchangeId: 'bitget',
      contractExchangeId: 'okx',
      symbol: SYMBOL,
      requestedBaseQuantity: '1',
      effectiveBaseQuantity: '1',
      mode: 'CONCURRENT',
      failureCode: null,
      createdAt: '2026-07-31T00:00:00.000Z',
      updatedAt: '2026-07-31T00:00:00.000Z'
    },
    preflight,
    orders: [],
    actualFills: {
      spotBuyBaseQuantity: '0',
      contractShortBaseQuantity: '0',
      unmatchedBaseQuantity: '0'
    },
    ...overrides
  };
}

function browserContractFirstWaitingStatus(
  strategyId: string
): Record<string, unknown> {
  const status = browserStatusResponse();
  Object.assign(status.strategy as Record<string, unknown>, {
    id: strategyId,
    state: 'WAITING_HEDGE',
    mode: 'CONTRACT_FIRST'
  });
  (status.preflight as Record<string, unknown>).mode = 'CONTRACT_FIRST';
  const contract = browserOrderResponse(
    strategyId,
    'CONTRACT_MARKET',
    '423e4567-e89b-42d3-a456-426614174001'
  );
  Object.assign(contract.snapshot as Record<string, unknown>, {
    filledBaseQuantity: '1',
    remainingBaseQuantity: '0',
    averagePrice: '60010',
    status: 'closed'
  });
  contract.status = 'closed';
  const spotHedge = browserOrderResponse(
    strategyId,
    'SPOT_HEDGE_GTC',
    '423e4567-e89b-42d3-a456-426614174002'
  );
  status.orders = [contract, spotHedge];
  status.actualFills = {
    spotBuyBaseQuantity: '0',
    contractShortBaseQuantity: '1',
    unmatchedBaseQuantity: '1'
  };
  return status;
}

async function browserHarness(
  initialFetch?: BrowserFetch
): Promise<BrowserHarness> {
  const ids = [
    'spot-exchange',
    'contract-exchange',
    'symbol',
    'base-quantity',
    'mode',
    'preflight-form',
    'preflight-button',
    'resume-strategy-id',
    'resume-form',
    'load-strategy-button',
    'risk-ack',
    'confirm-button',
    'refresh-button',
    'operator-message',
    'requested-quantity',
    'effective-quantity',
    'spot-price',
    'contract-price',
    'spot-balance',
    'contract-balance',
    'margin-mode',
    'position-mode',
    'leverage',
    'strategy-id',
    'strategy-state',
    'spot-order-ids',
    'contract-order-ids',
    'spot-actual-fill',
    'contract-actual-fill',
    'unmatched-quantity'
  ];
  const elements = new Map(ids.map((id) => [id, new FakeBrowserElement()]));
  const fetchCalls: BrowserHarness['fetchCalls'] = [];
  let currentFetch: BrowserFetch = initialFetch ?? (async (url) => {
    if (url === '/api/exchanges') {
      return browserResponse(200, { exchanges: ['bitget', 'okx'] });
    }
    throw new Error(`unexpected browser test URL: ${url}`);
  });
  const document = {
    querySelector(selector: string): FakeBrowserElement {
      const element = elements.get(selector.replace(/^#/, ''));
      if (element === undefined) {
        throw new Error(`missing fake element: ${selector}`);
      }
      return element;
    },
    createElement(): FakeBrowserElement {
      return new FakeBrowserElement();
    }
  };
  const script = await readFile('public/app.js', 'utf8');
  runInNewContext(script, {
    crypto: webcrypto,
    document,
    fetch: async (
      url: string,
      options?: Record<string, unknown>
    ): Promise<FakeBrowserResponse> => {
      fetchCalls.push({ url, options });
      return currentFetch(url, options);
    },
    TextEncoder
  });
  await flushImmediate();
  elements.get('spot-exchange')!.value = 'bitget';
  elements.get('contract-exchange')!.value = 'okx';
  elements.get('symbol')!.value = SYMBOL;
  elements.get('base-quantity')!.value = '1';
  elements.get('mode')!.value = 'CONCURRENT';
  return {
    fetchCalls,
    element(id: string): FakeBrowserElement {
      const element = elements.get(id);
      assert.ok(element, `missing fake browser element ${id}`);
      return element;
    },
    setFetch(fetch: BrowserFetch): void {
      currentFetch = fetch;
    }
  };
}

async function browserWithValidPreflight(): Promise<BrowserHarness> {
  const browser = await browserHarness();
  browser.setFetch(async (url) => {
    assert.equal(url, '/api/hedges/preflight');
    return browserResponse(201, browserPreflightResponse());
  });
  await browser.element('preflight-form').emit('submit');
  return browser;
}

const DETAILED_BROWSER_ERROR = {
  code: 'PREFLIGHT_REJECTED',
  message: 'Preflight checks did not pass',
  requestId: 'req-3',
  error: {
    type: 'AuthenticationError',
    code: '40101',
    message: '<b>bitget authentication failed</b>'
  }
} as const;

function detailedBrowserMessage(operation: string, status: number): string {
  return [
    `${operation}失败`,
    `HTTP ${status} · PREFLIGHT_REJECTED`,
    'AuthenticationError [40101]: <b>bitget authentication failed</b>',
    '请求 ID：req-3'
  ].join('\n');
}

test('operator UI shows detailed structured preflight failures as plain text', async () => {
  const browser = await browserHarness();
  browser.setFetch(async (url) => {
    assert.equal(url, '/api/hedges/preflight');
    return browserResponse(422, DETAILED_BROWSER_ERROR);
  });

  await browser.element('preflight-form').emit('submit');

  assert.equal(
    browser.element('operator-message').textContent,
    detailedBrowserMessage('预检', 422)
  );
  assert.match(browser.element('operator-message').textContent, /<b>.*<\/b>/);
  assert.equal(browser.element('strategy-state').textContent, '—');
  assert.equal(browser.element('confirm-button').disabled, true);
});

test('operator UI shows detailed structured strategy-load failures', async () => {
  const browser = await browserHarness();
  browser.element('resume-strategy-id').value =
    '123e4567-e89b-42d3-a456-426614174007';
  browser.setFetch(async () => browserResponse(404, DETAILED_BROWSER_ERROR));

  await browser.element('resume-form').emit('submit');

  assert.equal(
    browser.element('operator-message').textContent,
    detailedBrowserMessage('策略加载', 404)
  );
  assert.equal(browser.element('risk-ack').checked, false);
  assert.equal(browser.element('confirm-button').disabled, true);
});

test('operator UI shows detailed structured status-refresh failures', async () => {
  const browser = await browserWithValidPreflight();
  browser.setFetch(async () => browserResponse(503, DETAILED_BROWSER_ERROR));

  await browser.element('refresh-button').emit('click');

  assert.equal(
    browser.element('operator-message').textContent,
    detailedBrowserMessage('状态刷新', 503)
  );
  assert.equal(browser.element('strategy-state').textContent, '—');
  assert.equal(browser.element('confirm-button').disabled, true);
});

test('operator UI shows detailed structured confirmation failures', async () => {
  const browser = await browserWithValidPreflight();
  browser.element('risk-ack').checked = true;
  await browser.element('risk-ack').emit('change');
  browser.setFetch(async () => browserResponse(409, DETAILED_BROWSER_ERROR));

  await browser.element('confirm-button').emit('click');

  assert.equal(
    browser.element('operator-message').textContent,
    detailedBrowserMessage('确认', 409)
  );
  assert.equal(browser.element('confirm-button').disabled, false);
});

test('operator UI shows detailed structured exchange-list failures', async () => {
  const browser = await browserHarness(async (url) => {
    assert.equal(url, '/api/exchanges');
    return browserResponse(500, DETAILED_BROWSER_ERROR);
  });

  assert.equal(
    browser.element('operator-message').textContent,
    detailedBrowserMessage('交易所列表加载', 500)
  );
});

test('operator UI keeps legacy JSON errors readable', async () => {
  const browser = await browserHarness();
  browser.setFetch(async () => browserResponse(422, {
    code: 'LEGACY_REJECTED',
    message: 'legacy detailed failure'
  }));

  await browser.element('preflight-form').emit('submit');

  assert.equal(browser.element('operator-message').textContent, [
    '预检失败',
    'HTTP 422 · LEGACY_REJECTED',
    'legacy detailed failure'
  ].join('\n'));
});

test('operator UI distinguishes non-JSON and network failures', async (t) => {
  await t.test('non-JSON', async () => {
    const browser = await browserHarness();
    browser.setFetch(async () => ({
      status: 502,
      ok: false,
      json: async (): Promise<unknown> => {
        throw new Error('not JSON');
      }
    }));

    await browser.element('preflight-form').emit('submit');

    assert.equal(browser.element('operator-message').textContent, [
      '预检失败',
      'HTTP 502',
      '响应不是有效的结构化 JSON 错误'
    ].join('\n'));
  });

  await t.test('network', async () => {
    const browser = await browserHarness();
    browser.setFetch(async () => {
      throw new Error('connection refused');
    });

    await browser.element('preflight-form').emit('submit');

    assert.equal(browser.element('operator-message').textContent, [
      '预检失败',
      '网络错误：connection refused'
    ].join('\n'));
  });
});

test('operator UI bounds detailed server errors and labels invalid success responses', async (t) => {
  await t.test('bounded detail', async () => {
    const browser = await browserHarness();
    browser.setFetch(async () => browserResponse(422, {
      ...DETAILED_BROWSER_ERROR,
      error: {
        ...DETAILED_BROWSER_ERROR.error,
        message: 'x'.repeat(2_100)
      }
    }));

    await browser.element('preflight-form').emit('submit');

    const message = browser.element('operator-message').textContent;
    assert.match(message, /…\[truncated\]/);
    assert.ok(message.length < 2_200);
  });

  await t.test('invalid success response', async () => {
    const browser = await browserHarness();
    browser.setFetch(async () => browserResponse(201, { invalid: true }));

    await browser.element('preflight-form').emit('submit');

    assert.match(
      browser.element('operator-message').textContent,
      /^预检失败\n响应校验失败：/
    );
    assert.equal(browser.element('strategy-state').textContent, '—');
    assert.equal(browser.element('confirm-button').disabled, true);
  });
});

test('lists only configured exchange ids', async (t) => {
  const { server } = setup(t);

  const response = await server.inject({
    method: 'GET',
    url: '/api/exchanges',
    headers: LOCAL_HEADERS
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { exchanges: ['bitget', 'okx'] });
  assert.match(response.headers['cache-control'] ?? '', /no-store/);
});

test('rejects non-loopback and malformed Host before every route boundary', async (t) => {
  const database = new Database(':memory:');
  const targetRepository = new SqliteStrategyRepository(database);
  const strategy = targetRepository.createPending(preflight());
  let registryCalls = 0;
  let preflightCalls = 0;
  let repositoryCalls = 0;
  let coordinatorCalls = 0;
  const repository = new Proxy<StrategyRepository>(targetRepository, {
    get(target, property) {
      const value = Reflect.get(target, property);
      if (typeof value !== 'function') {
        return value;
      }
      return (...args: unknown[]) => {
        repositoryCalls += 1;
        return Reflect.apply(value, target, args);
      };
    }
  });
  const server = buildServer({
    registry: {
      ids: () => {
        registryCalls += 1;
        return ['bitget', 'okx'];
      }
    },
    preflightService: {
      run: async () => {
        preflightCalls += 1;
        return preflight();
      }
    },
    repository,
    coordinator: {
      confirmAndExecute: async () => {
        coordinatorCalls += 1;
      }
    },
    logger: false
  });
  t.after(async () => {
    await server.close();
    database.close();
  });
  const invalidHosts = [
    'evil.example',
    '127.0.0.2',
    '0.0.0.0',
    '[::2]',
    'localhost.evil.example',
    'localhost@evil.example',
    'user@localhost',
    'localhost:0',
    'localhost:65536',
    'localhost:notaport',
    'http://localhost',
    'localhost:80,evil.example'
  ];
  const validPreflightPayload = {
    spotExchangeId: 'bitget',
    contractExchangeId: 'okx',
    symbol: SYMBOL,
    requestedBaseQuantity: '1',
    mode: 'CONCURRENT'
  };

  for (const host of invalidHosts) {
    const requests = [
      server.inject({
        method: 'GET',
        url: '/api/exchanges',
        headers: {
          host,
          'x-forwarded-host': 'localhost:80'
        }
      }),
      server.inject({
        method: 'POST',
        url: '/api/hedges/preflight',
        headers: {
          host,
          'x-forwarded-host': 'localhost:80'
        },
        payload: validPreflightPayload
      }),
      server.inject({
        method: 'POST',
        url: `/api/hedges/${strategy.id}/confirm`,
        headers: {
          host,
          'x-forwarded-host': 'localhost:80'
        },
        payload: { riskAcknowledged: true }
      }),
      server.inject({
        method: 'GET',
        url: '/',
        headers: {
          host,
          'x-forwarded-host': 'localhost:80'
        }
      })
    ];
    for (const response of await Promise.all(requests)) {
      assert.equal(response.statusCode, 403, `host=${JSON.stringify(host)}`);
      assertPublicHttpError(response, {
        code: 'FORBIDDEN',
        message: 'Request forbidden'
      });
      assert.doesNotMatch(response.body, new RegExp(
        host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') || 'evil.example'
      ));
    }
  }
  await flushImmediate();
  assert.equal(registryCalls, 0);
  assert.equal(preflightCalls, 0);
  assert.equal(repositoryCalls, 0);
  assert.equal(coordinatorCalls, 0);
});

test('rejects unsafe browser origins before preflight, repository, or coordinator', async (t) => {
  const database = new Database(':memory:');
  const targetRepository = new SqliteStrategyRepository(database);
  const strategy = targetRepository.createPending(preflight());
  let repositoryCalls = 0;
  let preflightCalls = 0;
  let coordinatorCalls = 0;
  const repository = new Proxy<StrategyRepository>(targetRepository, {
    get(target, property) {
      const value = Reflect.get(target, property);
      if (typeof value !== 'function') {
        return value;
      }
      return (...args: unknown[]) => {
        repositoryCalls += 1;
        return Reflect.apply(value, target, args);
      };
    }
  });
  const server = buildServer({
    registry: { ids: () => ['bitget', 'okx'] },
    preflightService: {
      run: async () => {
        preflightCalls += 1;
        return preflight();
      }
    },
    repository,
    coordinator: {
      confirmAndExecute: async () => {
        coordinatorCalls += 1;
      }
    },
    logger: false
  });
  t.after(async () => {
    await server.close();
    database.close();
  });
  const invalidOrigins = [
    'null',
    'http://evil.example',
    'http://localhost:81',
    'https://localhost',
    'http://127.0.0.1:80',
    'http://user@localhost:80',
    'http://localhost:80/path',
    'not-an-origin'
  ];
  const payload = {
    spotExchangeId: 'bitget',
    contractExchangeId: 'okx',
    symbol: SYMBOL,
    requestedBaseQuantity: '1',
    mode: 'CONCURRENT'
  };

  for (const origin of invalidOrigins) {
    const responses = await Promise.all([
      server.inject({
        method: 'POST',
        url: '/api/hedges/preflight',
        headers: {
          host: 'localhost:80',
          origin
        },
        payload
      }),
      server.inject({
        method: 'POST',
        url: `/api/hedges/${strategy.id}/confirm`,
        headers: {
          host: 'localhost:80',
          origin
        },
        payload: { riskAcknowledged: true }
      })
    ]);
    for (const response of responses) {
      assert.equal(response.statusCode, 403);
      assertPublicHttpError(response, {
        code: 'FORBIDDEN',
        message: 'Request forbidden'
      });
      assert.doesNotMatch(response.body, /evil|user@|not-an-origin/);
    }
  }
  for (const url of [
    '/api/hedges/preflight',
    `/api/hedges/${strategy.id}/confirm`
  ]) {
    const response = await server.inject({
      method: 'POST',
      url,
      headers: {
        host: 'localhost:80',
        'sec-fetch-site': 'cross-site'
      },
      payload: url.endsWith('/preflight')
        ? payload
        : { riskAcknowledged: true }
    });
    assert.equal(response.statusCode, 403);
  }
  await flushImmediate();
  assert.equal(preflightCalls, 0);
  assert.equal(repositoryCalls, 0);
  assert.equal(coordinatorCalls, 0);
});

test('requires Origin on every POST before any write-path dependency', async (t) => {
  const database = new Database(':memory:');
  const targetRepository = new SqliteStrategyRepository(database);
  const strategy = targetRepository.createPending(preflight());
  let repositoryCalls = 0;
  let preflightCalls = 0;
  let coordinatorCalls = 0;
  const repository = new Proxy<StrategyRepository>(targetRepository, {
    get(target, property) {
      const value = Reflect.get(target, property);
      if (typeof value !== 'function') {
        return value;
      }
      return (...args: unknown[]) => {
        repositoryCalls += 1;
        return Reflect.apply(value, target, args);
      };
    }
  });
  const server = buildServer({
    registry: { ids: () => ['bitget', 'okx'] },
    preflightService: {
      run: async () => {
        preflightCalls += 1;
        return preflight();
      }
    },
    repository,
    coordinator: {
      confirmAndExecute: async () => {
        coordinatorCalls += 1;
      }
    },
    logger: false
  });
  t.after(async () => {
    await server.close();
    database.close();
  });

  const [preflightResponse, confirmationResponse] = await Promise.all([
    server.inject({
      method: 'POST',
      url: '/api/hedges/preflight',
      headers: { host: 'localhost:80' },
      payload: {
        spotExchangeId: 'bitget',
        contractExchangeId: 'okx',
        symbol: SYMBOL,
        requestedBaseQuantity: '1',
        mode: 'CONCURRENT'
      }
    }),
    server.inject({
      method: 'POST',
      url: `/api/hedges/${strategy.id}/confirm`,
      headers: { host: 'localhost:80' },
      payload: { riskAcknowledged: true }
    })
  ]);

  for (const response of [preflightResponse, confirmationResponse]) {
    assert.equal(response.statusCode, 403);
    assertPublicHttpError(response, {
      code: 'FORBIDDEN',
      message: 'Request forbidden'
    });
  }
  await flushImmediate();
  assert.equal(preflightCalls, 0);
  assert.equal(repositoryCalls, 0);
  assert.equal(coordinatorCalls, 0);
});

test('allows matching loopback Host and Origin forms', async (t) => {
  const { server, preflightInputs } = setup(t);
  const loopbackPairs = [
    ['localhost', 'http://localhost'],
    ['localhost:8080', 'http://localhost:8080'],
    ['127.0.0.1:8081', 'http://127.0.0.1:8081'],
    ['[::1]:8082', 'http://[::1]:8082']
  ] as const;

  for (const [host, origin] of loopbackPairs) {
    const exchanges = await server.inject({
      method: 'GET',
      url: '/api/exchanges',
      headers: { host }
    });
    assert.equal(exchanges.statusCode, 200);
    const response = await server.inject({
      method: 'POST',
      url: '/api/hedges/preflight',
      headers: { host, origin },
      payload: {
        spotExchangeId: 'bitget',
        contractExchangeId: 'okx',
        symbol: SYMBOL,
        requestedBaseQuantity: '1',
        mode: 'CONCURRENT'
      }
    });
    assert.equal(response.statusCode, 201);
    const confirmation = await server.inject({
      method: 'POST',
      url: `/api/hedges/${response.json().id}/confirm`,
      headers: { host, origin },
      payload: { riskAcknowledged: true }
    });
    assert.equal(confirmation.statusCode, 202);
  }
  assert.equal(preflightInputs.length, loopbackPairs.length);
});

test('requires the local HTTP origin scheme and ignores forwarded protocol', async (t) => {
  const { server, preflightInputs } = setup(t);
  const payload = {
    spotExchangeId: 'bitget',
    contractExchangeId: 'okx',
    symbol: SYMBOL,
    requestedBaseQuantity: '1',
    mode: 'CONCURRENT'
  };
  const wrongScheme = await server.inject({
    method: 'POST',
    url: '/api/hedges/preflight',
    headers: {
      host: 'localhost:80',
      origin: 'https://localhost:80',
      'x-forwarded-proto': 'https'
    },
    payload
  });
  assert.equal(wrongScheme.statusCode, 403);
  assertPublicHttpError(wrongScheme, {
    code: 'FORBIDDEN',
    message: 'Request forbidden'
  });
  assert.equal(preflightInputs.length, 0);

  const forwardedProtocolIgnored = await server.inject({
    method: 'POST',
    url: '/api/hedges/preflight',
    headers: {
      host: 'localhost:80',
      origin: 'http://localhost:80',
      'x-forwarded-proto': 'https'
    },
    payload
  });
  assert.equal(forwardedProtocolIgnored.statusCode, 201);
  assert.equal(preflightInputs.length, 1);
});

test('preflight requires exactly five public fields and persists a pending strategy', async (t) => {
  const { server, repository, preflightInputs } = setup(t);
  const payload: PreflightInput = {
    spotExchangeId: 'bitget',
    contractExchangeId: 'okx',
    symbol: SYMBOL,
    requestedBaseQuantity: '1',
    mode: 'CONTRACT_FIRST'
  };

  const response = await server.inject({
    method: 'POST',
    url: '/api/hedges/preflight',
    headers: LOCAL_HEADERS,
    payload
  });

  assert.equal(response.statusCode, 201);
  assert.deepEqual(preflightInputs, [payload]);
  const body = response.json();
  assert.equal(body.state, 'PENDING_CONFIRMATION');
  assert.equal(body.preflight.riskAcknowledgementRequired, true);
  assert.equal(repository.getStrategy(body.id).state, 'PENDING_CONFIRMATION');
  assert.deepEqual(Object.keys(body).sort(), ['id', 'preflight', 'state']);
  assert.doesNotMatch(response.body, /gateway|credential|api.?key|secret|password/i);
});

test('preflight rejects missing, extra, secret, malformed, and oversized fields without running checks', async (t) => {
  const { server, preflightInputs } = setup(t);
  const valid = {
    spotExchangeId: 'bitget',
    contractExchangeId: 'okx',
    symbol: SYMBOL,
    requestedBaseQuantity: '1',
    mode: 'CONCURRENT'
  };
  const invalidPayloads = [
    {
      spotExchangeId: 'bitget',
      contractExchangeId: 'okx',
      symbol: SYMBOL,
      requestedBaseQuantity: '1'
    },
    { ...valid, extra: 'not-allowed' },
    { ...valid, apiKey: 'LEAK-ME-NOT' },
    { ...valid, secret: 'LEAK-ME-NOT' },
    { ...valid, password: 'LEAK-ME-NOT' },
    { ...valid, signature: 'LEAK-ME-NOT' },
    { ...valid, mode: 'AUTO' },
    { ...valid, requestedBaseQuantity: '-1' },
    { ...valid, requestedBaseQuantity: '1e999999' },
    { ...valid, requestedBaseQuantity: '1'.repeat(257) },
    { ...valid, spotExchangeId: 'x'.repeat(129) }
  ];

  for (const payload of invalidPayloads) {
    const response = await server.inject({
      method: 'POST',
      url: '/api/hedges/preflight',
      headers: LOCAL_HEADERS,
      payload
    });
    assert.equal(response.statusCode, 400);
    assertPublicHttpError(response, {
      code: 'INVALID_REQUEST',
      message: 'Request validation failed'
    });
    assert.doesNotMatch(response.body, /LEAK-ME-NOT/);
  }
  assert.equal(preflightInputs.length, 0);
});

test('preflight never coerces runtime types for any string field', async (t) => {
  const { server, preflightInputs } = setup(t);
  const valid = {
    spotExchangeId: 'bitget',
    contractExchangeId: 'okx',
    symbol: SYMBOL,
    requestedBaseQuantity: '1',
    mode: 'CONCURRENT'
  };
  const validValues = {
    spotExchangeId: 'bitget',
    contractExchangeId: 'okx',
    symbol: SYMBOL,
    requestedBaseQuantity: '1',
    mode: 'CONCURRENT'
  } as const;
  const fields = Object.keys(validValues) as Array<keyof typeof validValues>;

  for (const field of fields) {
    for (const invalidValue of [
      1,
      true,
      [validValues[field]],
      { value: 'TYPE-SENTINEL' }
    ]) {
      const response = await server.inject({
        method: 'POST',
        url: '/api/hedges/preflight',
        headers: LOCAL_HEADERS,
        payload: {
          ...valid,
          [field]: invalidValue
        }
      });
      assert.equal(
        response.statusCode,
        400,
        `${field} accepted ${JSON.stringify(invalidValue)}`
      );
      assertPublicHttpError(response, {
        code: 'INVALID_REQUEST',
        message: 'Request validation failed'
      });
      assert.doesNotMatch(response.body, /TYPE-SENTINEL/);
    }
  }
  assert.equal(preflightInputs.length, 0);
});

test('preflight failure returns detailed sanitized diagnostics', async (t) => {
  const failure = Object.assign(
    new Error('bitget credential-value authentication failed'),
    {
      name: 'AuthenticationError',
      code: 401,
      rawResponse: 'LEAK-ME-NOT'
    }
  );
  const { server } = setup(t, {
    runPreflight: async () => {
      throw failure;
    },
    secretProvider: () => ['credential-value']
  });

  const response = await server.inject({
    method: 'POST',
    url: '/api/hedges/preflight',
    headers: LOCAL_HEADERS,
    payload: {
      spotExchangeId: 'bitget',
      contractExchangeId: 'okx',
      symbol: SYMBOL,
      requestedBaseQuantity: '1',
      mode: 'SPOT_FIRST'
    }
  });

  assert.equal(response.statusCode, 422);
  const body = response.json();
  assert.deepEqual(body, {
    code: 'PREFLIGHT_REJECTED',
    message: 'Preflight checks did not pass',
    requestId: body.requestId,
    error: {
      type: 'AuthenticationError',
      code: 401,
      message: 'bitget [Redacted] authentication failed'
    }
  });
  assert.equal(typeof body.requestId, 'string');
  assert.doesNotMatch(
    response.body,
    /credential-value|LEAK-ME-NOT|rawResponse|stack/
  );
});

test('a failing secret provider omits detail without changing the preflight response', async (t) => {
  const { server } = setup(t, {
    runPreflight: async () => {
      throw new Error('sensitive failure');
    },
    secretProvider: () => {
      throw new Error('secret provider unavailable');
    }
  });

  const response = await server.inject({
    method: 'POST',
    url: '/api/hedges/preflight',
    headers: LOCAL_HEADERS,
    payload: {
      spotExchangeId: 'bitget',
      contractExchangeId: 'okx',
      symbol: SYMBOL,
      requestedBaseQuantity: '1',
      mode: 'SPOT_FIRST'
    }
  });

  assert.equal(response.statusCode, 422);
  const body = response.json();
  assert.deepEqual(body, {
    code: 'PREFLIGHT_REJECTED',
    message: 'Preflight checks did not pass',
    requestId: body.requestId
  });
  assert.equal(typeof body.requestId, 'string');
  assert.doesNotMatch(response.body, /sensitive failure|secret provider/);
});

test('confirmation requires the exact true risk acknowledgement before queueing', async (t) => {
  const { server, repository, getExecutionCount } = setup(t);
  const strategy = repository.createPending(preflight());
  const invalidPayloads = [
    undefined,
    {},
    { riskAcknowledged: false },
    { riskAcknowledged: true, extra: true }
  ];

  for (const payload of invalidPayloads) {
    const response = await server.inject({
      method: 'POST',
      url: `/api/hedges/${strategy.id}/confirm`,
      headers: LOCAL_HEADERS,
      ...(payload === undefined ? {} : { payload })
    });
    assert.equal(response.statusCode, 400);
  }
  await flushImmediate();
  assert.equal(getExecutionCount(), 0);
  assert.equal(repository.getStrategy(strategy.id).state, 'PENDING_CONFIRMATION');
});

test('confirmation never coerces acknowledgement runtime types', async (t) => {
  const { server, repository, getExecutionCount } = setup(t);
  const strategy = repository.createPending(preflight());

  for (const riskAcknowledged of [
    'true',
    1,
    [true],
    { value: 'TYPE-SENTINEL' }
  ]) {
    const response = await server.inject({
      method: 'POST',
      url: `/api/hedges/${strategy.id}/confirm`,
      headers: LOCAL_HEADERS,
      payload: { riskAcknowledged }
    });
    assert.equal(
      response.statusCode,
      400,
      `accepted ${JSON.stringify(riskAcknowledged)}`
    );
    assertPublicHttpError(response, {
      code: 'INVALID_REQUEST',
      message: 'Request validation failed'
    });
    assert.doesNotMatch(response.body, /TYPE-SENTINEL/);
  }
  await flushImmediate();
  assert.equal(getExecutionCount(), 0);
  assert.equal(repository.getStrategy(strategy.id).state, 'PENDING_CONFIRMATION');
});

test('confirmation returns detailed 404 for an unknown strategy without queueing', async (t) => {
  const { server, getExecutionCount } = setup(t, {
    secretProvider: () => []
  });

  const response = await server.inject({
    method: 'POST',
    url: '/api/hedges/missing-strategy/confirm',
    headers: LOCAL_HEADERS,
    payload: { riskAcknowledged: true }
  });

  assert.equal(response.statusCode, 404);
  assertPublicHttpError(response, {
    code: 'STRATEGY_NOT_FOUND',
    message: 'Strategy not found',
    error: {
      type: 'StrategyNotFoundError',
      message: 'unknown strategy'
    }
  });
  await flushImmediate();
  assert.equal(getExecutionCount(), 0);
});

test('two concurrent confirmations queue only one coordinator execution', async (t) => {
  let releaseExecution: (() => void) | undefined;
  const executionGate = new Promise<void>((resolve) => {
    releaseExecution = resolve;
  });
  const fixture = setup(t, {
    confirmAndExecute: async () => executionGate
  });
  const strategy = fixture.repository.createPending(preflight());

  const responses = await Promise.all([
    fixture.server.inject({
      method: 'POST',
      url: `/api/hedges/${strategy.id}/confirm`,
      headers: LOCAL_HEADERS,
      payload: { riskAcknowledged: true }
    }),
    fixture.server.inject({
      method: 'POST',
      url: `/api/hedges/${strategy.id}/confirm`,
      headers: LOCAL_HEADERS,
      payload: { riskAcknowledged: true }
    })
  ]);

  assert.deepEqual(
    responses.map((response) => response.statusCode).sort(),
    [202, 202]
  );
  assert.ok(responses.every((response) => (
    response.json().accepted === true
  )));
  await flushImmediate();
  assert.equal(fixture.getExecutionCount(), 1);
  releaseExecution?.();
});

test('two concurrent confirmations create each fake exchange order only once', async (t) => {
  const database = new Database(':memory:');
  const repository = new SqliteStrategyRepository(database);
  const spot = new FakeExchangeGateway('bitget');
  const contract = new FakeExchangeGateway('okx');
  const registry = new ExchangeRegistry(new Map([
    ['bitget', spot],
    ['okx', contract]
  ]));
  const strategy = repository.createPending(preflight());
  const contractRequest = requestFor(
    strategy.id,
    'CONTRACT_MARKET',
    strategy.effectiveBaseQuantity
  );
  const spotRequest = requestFor(
    strategy.id,
    'SPOT_HEDGE_GTC',
    strategy.effectiveBaseQuantity
  );
  contract.createResults.push(snapshotFor(contractRequest, 'okx', {
    filledBaseQuantity: '1',
    remainingBaseQuantity: '0',
    averagePrice: '60010',
    status: 'closed'
  }));
  spot.createResults.push(snapshotFor(spotRequest, 'bitget', {
    filledBaseQuantity: '1',
    remainingBaseQuantity: '0',
    averagePrice: '60010',
    status: 'closed'
  }));
  const server = buildServer({
    registry,
    preflightService: {
      run: async () => {
        throw new Error('not used');
      }
    },
    repository,
    coordinator: new HedgeCoordinator(registry, repository),
    logger: false
  });
  t.after(async () => {
    await server.close();
    database.close();
  });

  const responses = await Promise.all([
    server.inject({
      method: 'POST',
      url: `/api/hedges/${strategy.id}/confirm`,
      headers: LOCAL_HEADERS,
      payload: { riskAcknowledged: true }
    }),
    server.inject({
      method: 'POST',
      url: `/api/hedges/${strategy.id}/confirm`,
      headers: LOCAL_HEADERS,
      payload: { riskAcknowledged: true }
    })
  ]);
  await server.close();

  assert.deepEqual(
    responses.map((response) => response.statusCode).sort(),
    [202, 202]
  );
  assert.equal(contract.createdRequests.length, 1);
  assert.equal(spot.createdRequests.length, 1);
  assert.equal(repository.getStrategy(strategy.id).state, 'HEDGED');
});

test('an EXECUTING strategy can be confirmed again after background failure', async (t) => {
  const fixture = setup(t, {
    confirmAndExecute: async () => {
      throw new Error('fixed background failure');
    }
  });
  const strategy = fixture.repository.createPending(preflight());
  assert.equal(fixture.repository.claimForExecution(strategy.id), true);

  const first = await fixture.server.inject({
    method: 'POST',
    url: `/api/hedges/${strategy.id}/confirm`,
    headers: LOCAL_HEADERS,
    payload: { riskAcknowledged: true }
  });
  assert.equal(first.statusCode, 202);
  await flushImmediate();
  assert.equal(fixture.getExecutionCount(), 1);
  assert.equal(
    fixture.repository.getStrategy(strategy.id).state,
    'EXECUTING'
  );

  const second = await fixture.server.inject({
    method: 'POST',
    url: `/api/hedges/${strategy.id}/confirm`,
    headers: LOCAL_HEADERS,
    payload: { riskAcknowledged: true }
  });
  assert.equal(second.statusCode, 202);
  await flushImmediate();
  assert.equal(fixture.getExecutionCount(), 2);
});

test('EXECUTING confirmation recovers an existing intent without duplicate create', async (t) => {
  const database = new Database(':memory:');
  const repository = new SqliteStrategyRepository(database);
  const spot = new FakeExchangeGateway('bitget');
  const contract = new FakeExchangeGateway('okx');
  const registry = new ExchangeRegistry(new Map([
    ['bitget', spot],
    ['okx', contract]
  ]));
  const strategy = repository.createPending(preflight());
  assert.equal(repository.claimForExecution(strategy.id), true);
  const contractRequest = requestFor(
    strategy.id,
    'CONTRACT_MARKET',
    strategy.effectiveBaseQuantity
  );
  repository.planOrder(strategy.id, 'CONTRACT_MARKET', contractRequest);
  contract.seedObservedOrder(snapshotFor(contractRequest, 'okx', {
    filledBaseQuantity: '1',
    remainingBaseQuantity: '0',
    averagePrice: '60010',
    status: 'closed'
  }));
  const spotRequest = requestFor(
    strategy.id,
    'SPOT_HEDGE_GTC',
    strategy.effectiveBaseQuantity
  );
  spot.createResults.push(snapshotFor(spotRequest, 'bitget', {
    filledBaseQuantity: '1',
    remainingBaseQuantity: '0',
    averagePrice: '60010',
    status: 'closed'
  }));
  const server = buildServer({
    registry,
    preflightService: {
      run: async () => {
        throw new Error('not used');
      }
    },
    repository,
    coordinator: new HedgeCoordinator(registry, repository),
    logger: false
  });
  t.after(async () => {
    await server.close();
    database.close();
  });

  const response = await server.inject({
    method: 'POST',
    url: `/api/hedges/${strategy.id}/confirm`,
    headers: LOCAL_HEADERS,
    payload: { riskAcknowledged: true }
  });
  await server.close();

  assert.equal(response.statusCode, 202);
  assert.equal(contract.createdRequests.length, 0);
  assert.equal(spot.createdRequests.length, 1);
  assert.equal(repository.getStrategy(strategy.id).state, 'HEDGED');
});

test('confirmation is an idempotent 202 for terminal strategies without new execution', async (t) => {
  const { server, repository, getExecutionCount } = setup(t);
  const strategy = repository.createPending(preflight());
  assert.equal(repository.claimForExecution(strategy.id), true);
  assert.equal(
    repository.transition(strategy.id, ['EXECUTING'], 'HEDGED'),
    true
  );

  const response = await server.inject({
    method: 'POST',
    url: `/api/hedges/${strategy.id}/confirm`,
    headers: LOCAL_HEADERS,
    payload: { riskAcknowledged: true }
  });

  assert.equal(response.statusCode, 202);
  assert.deepEqual(response.json(), { accepted: true });
  await flushImmediate();
  assert.equal(getExecutionCount(), 0);
});

test('background coordinator rejection is caught and server close drains queued work', async (t) => {
  const loggedErrors: CapturedOperationalError[] = [];
  let releaseExecution: (() => void) | undefined;
  const executionGate = new Promise<void>((resolve) => {
    releaseExecution = resolve;
  });
  const fixture = setup(t, {
    operationalLog: captureOperationalErrors(loggedErrors),
    confirmAndExecute: async () => {
      await executionGate;
      throw new Error('secret rejection detail LEAK-ME-NOT');
    }
  });
  const strategy = fixture.repository.createPending(preflight());
  let unhandledReason: unknown;
  const onUnhandled = (reason: unknown): void => {
    unhandledReason = reason;
  };
  process.once('unhandledRejection', onUnhandled);

  const response = await fixture.server.inject({
    method: 'POST',
    url: `/api/hedges/${strategy.id}/confirm`,
    headers: LOCAL_HEADERS,
    payload: { riskAcknowledged: true }
  });
  assert.equal(response.statusCode, 202);
  await flushImmediate();

  let closeFinished = false;
  const closePromise = fixture.server.close().then(() => {
    closeFinished = true;
  });
  await flushImmediate();
  assert.equal(closeFinished, false);

  releaseExecution?.();
  await closePromise;
  await flushImmediate();
  process.removeListener('unhandledRejection', onUnhandled);
  assert.equal(unhandledReason, undefined);
  assert.equal(loggedErrors.length, 1);
  assert.equal(loggedErrors[0]?.event, 'background_confirmation_failed');
  assert.equal(
    (loggedErrors[0]?.error as Error | undefined)?.message,
    'secret rejection detail LEAK-ME-NOT'
  );
  assert.deepEqual(loggedErrors[0]?.fields, { strategyId: strategy.id });
});

test('status uses only latest snapshots and preserves exact high precision fills', async (t) => {
  const { server, repository } = setup(t);
  const quantity = '1.0000000000000000000000000000000000000001';
  const strategy = repository.createPending(preflight({
    requestedBaseQuantity: quantity,
    effectiveBaseQuantity: quantity
  }));
  assert.equal(repository.claimForExecution(strategy.id), true);

  const spotRequest = requestFor(strategy.id, 'SPOT_MARKET', quantity);
  const spotOrder = repository.planOrder(
    strategy.id,
    'SPOT_MARKET',
    spotRequest
  );
  repository.attachOrderSnapshot(spotOrder.id, snapshotFor(
    spotRequest,
    'bitget',
    {
      filledBaseQuantity: '0.1000000000000000000000000000000000000001',
      remainingBaseQuantity: '0.9',
      averagePrice: '60000',
      updatedAt: '2026-07-31T00:01:00.000Z'
    }
  ));
  repository.attachOrderSnapshot(spotOrder.id, snapshotFor(
    spotRequest,
    'bitget',
    {
      filledBaseQuantity: '0.9000000000000000000000000000000000000001',
      remainingBaseQuantity: '0.1',
      averagePrice: '60000',
      status: 'closed',
      updatedAt: '2026-07-31T00:02:00.000Z'
    }
  ));

  const contractRequest = requestFor(
    strategy.id,
    'CONTRACT_MARKET',
    quantity
  );
  const contractOrder = repository.planOrder(
    strategy.id,
    'CONTRACT_MARKET',
    contractRequest
  );
  repository.attachOrderSnapshot(contractOrder.id, snapshotFor(
    contractRequest,
    'okx',
    {
      filledBaseQuantity: '0.8999999999999999999999999999999999999999',
      remainingBaseQuantity: '0.1000000000000000000000000000000000000002',
      averagePrice: '60010',
      status: 'closed',
      updatedAt: '2026-07-31T00:02:00.000Z'
    }
  ));

  const response = await server.inject({
    method: 'GET',
    url: `/api/hedges/${strategy.id}`,
    headers: LOCAL_HEADERS
  });

  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.strategy.id, strategy.id);
  assert.equal(body.preflight.effectiveBaseQuantity, quantity);
  assert.equal(body.orders.length, 2);
  assert.deepEqual(body.actualFills, {
    spotBuyBaseQuantity: '0.9000000000000000000000000000000000000001',
    contractShortBaseQuantity: '0.8999999999999999999999999999999999999999',
    unmatchedBaseQuantity: '0.0000000000000000000000000000000000000002'
  });
  assert.equal(repository.listOrderEvents(spotOrder.id).length, 2);
  assert.match(response.headers['cache-control'] ?? '', /no-store/);
  assert.match(response.headers['content-security-policy'] ?? '', /default-src 'self'/);
});

test('status reports zero actual fills for orders without snapshots', async (t) => {
  const { server, repository } = setup(t);
  const strategy = repository.createPending(preflight());
  assert.equal(repository.claimForExecution(strategy.id), true);
  repository.planOrder(
    strategy.id,
    'SPOT_MARKET',
    requestFor(strategy.id, 'SPOT_MARKET', '1')
  );
  repository.planOrder(
    strategy.id,
    'CONTRACT_MARKET',
    requestFor(strategy.id, 'CONTRACT_MARKET', '1')
  );

  const response = await server.inject({
    method: 'GET',
    url: `/api/hedges/${strategy.id}`,
    headers: LOCAL_HEADERS
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json().actualFills, {
    spotBuyBaseQuantity: '0',
    contractShortBaseQuantity: '0',
    unmatchedBaseQuantity: '0'
  });
});

test('status returns typed 404 and tampered repository failures return safe 500', async (t) => {
  const loggedErrors: CapturedOperationalError[] = [];
  const first = setup(t);
  const missing = await first.server.inject({
    method: 'GET',
    url: '/api/hedges/missing-strategy',
    headers: LOCAL_HEADERS
  });
  assert.equal(missing.statusCode, 404);

  const existing = first.repository.createPending(preflight());
  const tamperedRepository = new Proxy<StrategyRepository>(first.repository, {
    get(target, property, receiver) {
      if (property === 'listOrders') {
        return () => {
          throw new Error('sqlite row secret LEAK-ME-NOT');
        };
      }
      return Reflect.get(target, property, receiver);
    }
  });
  const second = setup(t, {
    repository: tamperedRepository,
    operationalLog: captureOperationalErrors(loggedErrors),
    secretProvider: () => ['LEAK-ME-NOT']
  });

  const tampered = await second.server.inject({
    method: 'GET',
    url: `/api/hedges/${existing.id}?apiKey=unconfigured-token`,
    headers: LOCAL_HEADERS
  });

  assert.equal(tampered.statusCode, 500);
  assertPublicHttpError(tampered, {
    code: 'INTERNAL_ERROR',
    message: 'Internal server error',
    error: {
      type: 'Error',
      message: 'sqlite row secret [Redacted]'
    }
  });
  assert.doesNotMatch(tampered.body, /LEAK-ME-NOT|unconfigured-token|apiKey/);
  assert.equal(loggedErrors.length, 1);
  assert.equal(loggedErrors[0]?.event, 'unhandled_http_request_failure');
  assert.equal(
    (loggedErrors[0]?.error as Error | undefined)?.message,
    'sqlite row secret LEAK-ME-NOT'
  );
  assert.deepEqual(loggedErrors[0]?.fields, {
    requestId: loggedErrors[0]?.fields?.requestId,
    method: 'GET',
    url: `/api/hedges/${existing.id}`
  });
  assert.equal(typeof loggedErrors[0]?.fields?.requestId, 'string');
  assert.doesNotMatch(
    JSON.stringify(loggedErrors[0]?.fields),
    /unconfigured-token|apiKey/
  );
});

test('a throwing operational log cannot replace an HTTP 500 response', async (t) => {
  const first = setup(t);
  const existing = first.repository.createPending(preflight());
  const tamperedRepository = new Proxy(first.repository, {
    get(target, property, receiver) {
      if (property === 'getStrategy') {
        return (): never => {
          throw new Error('repository failed');
        };
      }
      return Reflect.get(target, property, receiver);
    }
  });
  const second = setup(t, {
    repository: tamperedRepository,
    operationalLog: {
      info(): void {},
      error(): never {
        throw new Error('logging unavailable');
      },
      fatal(): void {}
    }
  });

  const response = await second.server.inject({
    method: 'GET',
    url: `/api/hedges/${existing.id}`,
    headers: LOCAL_HEADERS
  });

  assert.equal(response.statusCode, 500);
  assertPublicHttpError(response, {
    code: 'INTERNAL_ERROR',
    message: 'Internal server error'
  });
});

test('logger configuration redacts headers, direct secrets, and common nested credentials', () => {
  for (const path of [
    'req.headers.authorization',
    'req.headers.cookie',
    'req.body.apiKey',
    'req.body.secret',
    'req.body.password',
    'req.body.signature',
    'req.body.credentials.apiKey',
    'req.body.credentials.secret',
    'req.body.auth.password',
    'req.body.auth.signature'
  ]) {
    assert.ok(LOGGER_REDACT_PATHS.includes(path));
  }
});

test('operator UI rejects malformed preflight responses without retaining actionable state', async (t) => {
  const malformedResponses = [
    {
      name: 'missing account settings',
      response(): Record<string, unknown> {
        const body = browserPreflightResponse();
        const preview = body.preflight as Record<string, unknown>;
        delete preview.accountSettings;
        return body;
      }
    },
    {
      name: 'non-string effective quantity',
      response(): Record<string, unknown> {
        const body = browserPreflightResponse();
        const preview = body.preflight as Record<string, unknown>;
        preview.effectiveBaseQuantity = 1;
        return body;
      }
    }
  ];

  for (const malformed of malformedResponses) {
    await t.test(malformed.name, async () => {
      const browser = await browserHarness();
      browser.setFetch(async (url) => {
        assert.equal(url, '/api/hedges/preflight');
        return browserResponse(201, malformed.response());
      });

      await browser.element('preflight-form').emit('submit');
      assert.equal(browser.element('requested-quantity').textContent, '—');
      assert.equal(browser.element('effective-quantity').textContent, '—');
      assert.equal(browser.element('strategy-state').textContent, '—');
      assert.equal(browser.element('risk-ack').checked, false);
      assert.equal(browser.element('confirm-button').disabled, true);
      assert.equal(browser.element('refresh-button').disabled, true);

      browser.element('risk-ack').checked = true;
      await browser.element('risk-ack').emit('change');
      assert.equal(browser.element('confirm-button').disabled, true);
    });
  }
});

test('operator UI rejects mismatched or non-actionable preflight semantics', async (t) => {
  const invalidResponses = [
    {
      name: 'unknown margin mode',
      mutate(preview: Record<string, unknown>): void {
        const settings = preview.accountSettings as Record<string, unknown>;
        settings.marginMode = 'unknown';
      }
    },
    {
      name: 'null leverage',
      mutate(preview: Record<string, unknown>): void {
        const settings = preview.accountSettings as Record<string, unknown>;
        settings.leverage = null;
      }
    },
    {
      name: 'swapped exchanges',
      mutate(preview: Record<string, unknown>): void {
        preview.spotExchangeId = 'okx';
        preview.contractExchangeId = 'bitget';
      }
    },
    {
      name: 'symbol mismatch',
      mutate(preview: Record<string, unknown>): void {
        preview.symbol = 'ETH/USDT';
      }
    },
    {
      name: 'missing symbol',
      mutate(preview: Record<string, unknown>): void {
        delete preview.symbol;
      }
    },
    {
      name: 'mode mismatch',
      mutate(preview: Record<string, unknown>): void {
        preview.mode = 'SPOT_FIRST';
      }
    },
    {
      name: 'requested quantity mismatch',
      mutate(preview: Record<string, unknown>): void {
        preview.requestedBaseQuantity = '2';
      }
    },
    {
      name: 'zero effective quantity',
      mutate(preview: Record<string, unknown>): void {
        preview.effectiveBaseQuantity = '0';
      }
    },
    {
      name: 'non-finite spot price',
      mutate(preview: Record<string, unknown>): void {
        preview.spotReferencePrice = 'Infinity';
      }
    },
    {
      name: 'negative contract balance',
      mutate(preview: Record<string, unknown>): void {
        preview.contractFreeUsdt = '-1';
      }
    }
  ];

  for (const invalid of invalidResponses) {
    await t.test(invalid.name, async () => {
      const browser = await browserHarness();
      const body = browserPreflightResponse();
      invalid.mutate(body.preflight as Record<string, unknown>);
      browser.setFetch(async (url) => {
        assert.equal(url, '/api/hedges/preflight');
        return browserResponse(201, body);
      });

      await browser.element('preflight-form').emit('submit');
      assert.equal(browser.element('requested-quantity').textContent, '—');
      assert.equal(browser.element('effective-quantity').textContent, '—');
      assert.equal(browser.element('strategy-state').textContent, '—');
      assert.equal(browser.element('risk-ack').checked, false);
      assert.equal(browser.element('confirm-button').disabled, true);
      assert.equal(browser.element('refresh-button').disabled, true);

      browser.element('risk-ack').checked = true;
      await browser.element('risk-ack').emit('change');
      assert.equal(browser.element('confirm-button').disabled, true);
    });
  }
});

test('operator UI enables confirmation for a complete matching response', async () => {
  const browser = await browserHarness();
  browser.setFetch(async (url) => {
    assert.equal(url, '/api/hedges/preflight');
    return browserResponse(201, browserPreflightResponse());
  });

  await browser.element('preflight-form').emit('submit');
  assert.equal(browser.element('requested-quantity').textContent, '1');
  assert.equal(
    browser.element('strategy-id').textContent,
    'strategy-browser-1'
  );
  assert.equal(
    browser.element('strategy-state').textContent,
    'PENDING_CONFIRMATION'
  );
  assert.equal(browser.element('refresh-button').disabled, false);
  browser.element('risk-ack').checked = true;
  await browser.element('risk-ack').emit('change');
  assert.equal(browser.element('confirm-button').disabled, false);
});

test('operator UI validates against the immutable submitted snapshot', async () => {
  const browser = await browserHarness();
  let resolvePreflight: ((response: FakeBrowserResponse) => void) | undefined;
  const delayedPreflight = new Promise<FakeBrowserResponse>((resolve) => {
    resolvePreflight = resolve;
  });
  browser.setFetch(async (url) => {
    assert.equal(url, '/api/hedges/preflight');
    return delayedPreflight;
  });

  const pendingSubmission = browser.element('preflight-form').emit('submit');
  await flushImmediate();
  browser.element('base-quantity').value = '2';
  resolvePreflight?.(browserResponse(201, browserPreflightResponse()));
  await pendingSubmission;

  assert.equal(browser.element('requested-quantity').textContent, '1');
  browser.element('risk-ack').checked = true;
  await browser.element('risk-ack').emit('change');
  assert.equal(browser.element('confirm-button').disabled, false);
});

test('operator UI accepts a matching status id and canonical high-precision fills', async () => {
  const browser = await browserWithValidPreflight();
  browser.element('risk-ack').checked = true;
  await browser.element('risk-ack').emit('change');
  const highPrecision = '0.123456789012345678901234567890123456789';
  const order = browserOrderResponse(
    'strategy-browser-1',
    'CONTRACT_MARKET'
  );
  (order.request as Record<string, unknown>).baseQuantity = highPrecision;
  Object.assign(order.snapshot as Record<string, unknown>, {
    requestedBaseQuantity: highPrecision,
    filledBaseQuantity: highPrecision,
    remainingBaseQuantity: '0',
    averagePrice: '60010',
    status: 'closed'
  });
  order.status = 'closed';
  const spotOrder = browserOrderResponse(
    'strategy-browser-1',
    'SPOT_MARKET',
    '223e4567-e89b-42d3-a456-426614174015'
  );
  browser.setFetch(async (url) => {
    assert.equal(url, '/api/hedges/strategy-browser-1');
    const status = browserStatusResponse({
      orders: [spotOrder, order],
      actualFills: {
        spotBuyBaseQuantity: '0',
        contractShortBaseQuantity: highPrecision,
        unmatchedBaseQuantity: highPrecision
      }
    });
    return browserResponse(200, status);
  });

  await browser.element('refresh-button').emit('click');

  assert.equal(browser.element('strategy-state').textContent, 'EXECUTING');
  assert.equal(
    browser.element('strategy-id').textContent,
    'strategy-browser-1'
  );
  assert.equal(browser.element('spot-actual-fill').textContent, '0');
  assert.equal(
    browser.element('contract-actual-fill').textContent,
    highPrecision
  );
  assert.equal(
    browser.element('unmatched-quantity').textContent,
    highPrecision
  );
  assert.match(
    browser.element('contract-order-ids').children[0]?.textContent ?? '',
    /okx-/
  );
  assert.equal(browser.element('risk-ack').checked, true);
  assert.equal(browser.element('confirm-button').disabled, false);
});

test('operator UI rejects status strategy identity mismatches before rendering', async (t) => {
  const mismatches = [
    {
      name: 'different strategy id',
      mutate(body: Record<string, unknown>): void {
        const strategy = body.strategy as Record<string, unknown>;
        strategy.id = 'strategy-browser-2';
      }
    },
    {
      name: 'different strategy symbol',
      mutate(body: Record<string, unknown>): void {
        const strategy = body.strategy as Record<string, unknown>;
        strategy.symbol = 'ETH/USDT';
      }
    }
  ];

  for (const mismatch of mismatches) {
    await t.test(mismatch.name, async () => {
      const browser = await browserWithValidPreflight();
      browser.element('risk-ack').checked = true;
      await browser.element('risk-ack').emit('change');
      const body = browserStatusResponse({
        orders: [{
          role: 'SPOT_MARKET',
          clientOrderId: 'client-status-sentinel',
          exchangeOrderId: 'exchange-status-sentinel'
        }],
        actualFills: {
          spotBuyBaseQuantity: '9',
          contractShortBaseQuantity: '8',
          unmatchedBaseQuantity: '1'
        }
      });
      mismatch.mutate(body);
      browser.setFetch(async (url) => {
        assert.equal(url, '/api/hedges/strategy-browser-1');
        return browserResponse(200, body);
      });

      await browser.element('refresh-button').emit('click');

      assert.equal(browser.element('requested-quantity').textContent, '—');
      assert.equal(browser.element('strategy-state').textContent, '—');
      assert.equal(browser.element('spot-actual-fill').textContent, '0');
      assert.equal(browser.element('contract-actual-fill').textContent, '0');
      assert.equal(browser.element('unmatched-quantity').textContent, '0');
      assert.doesNotMatch(
        browser.element('spot-order-ids').children[0]?.textContent ?? '',
        /status-sentinel/
      );
      assert.equal(browser.element('risk-ack').checked, false);
      assert.equal(browser.element('confirm-button').disabled, true);
      assert.equal(browser.element('refresh-button').disabled, true);
    });
  }
});

test('operator UI rejects every non-canonical actual-fill field', async (t) => {
  const invalidFills = [
    ['spotBuyBaseQuantity', '-1'],
    ['spotBuyBaseQuantity', 'NaN'],
    ['contractShortBaseQuantity', 'Infinity'],
    ['contractShortBaseQuantity', '0x10'],
    ['unmatchedBaseQuantity', '1e3'],
    ['unmatchedBaseQuantity', ''],
    ['spotBuyBaseQuantity', '1'.repeat(10_001)],
    ['contractShortBaseQuantity', 1]
  ] as const;

  for (const [field, invalidValue] of invalidFills) {
    await t.test(`${field}=${String(invalidValue).slice(0, 32)}`, async () => {
      const browser = await browserWithValidPreflight();
      browser.element('risk-ack').checked = true;
      await browser.element('risk-ack').emit('change');
      const body = browserStatusResponse();
      const actualFills = body.actualFills as Record<string, unknown>;
      actualFills[field] = invalidValue;
      browser.setFetch(async (url) => {
        assert.equal(url, '/api/hedges/strategy-browser-1');
        return browserResponse(200, body);
      });

      await browser.element('refresh-button').emit('click');

      assert.equal(browser.element('requested-quantity').textContent, '—');
      assert.equal(browser.element('strategy-state').textContent, '—');
      assert.equal(browser.element('spot-actual-fill').textContent, '0');
      assert.equal(browser.element('contract-actual-fill').textContent, '0');
      assert.equal(browser.element('unmatched-quantity').textContent, '0');
      assert.equal(browser.element('risk-ack').checked, false);
      assert.equal(browser.element('confirm-button').disabled, true);
      assert.equal(browser.element('refresh-button').disabled, true);
    });
  }
});

test('operator UI ignores a delayed status response after input invalidation', async () => {
  const browser = await browserWithValidPreflight();
  let resolveStatus: ((response: FakeBrowserResponse) => void) | undefined;
  const delayedStatus = new Promise<FakeBrowserResponse>((resolve) => {
    resolveStatus = resolve;
  });
  browser.setFetch(async (url) => {
    assert.equal(url, '/api/hedges/strategy-browser-1');
    return delayedStatus;
  });

  const pendingRefresh = browser.element('refresh-button').emit('click');
  await flushImmediate();
  browser.element('base-quantity').value = '2';
  await browser.element('base-quantity').emit('input');
  resolveStatus?.(browserResponse(200, browserStatusResponse({
    orders: [{
      role: 'SPOT_MARKET',
      clientOrderId: 'client-stale-sentinel',
      exchangeOrderId: 'exchange-stale-sentinel'
    }],
    actualFills: {
      spotBuyBaseQuantity: '9',
      contractShortBaseQuantity: '8',
      unmatchedBaseQuantity: '1'
    }
  })));
  await pendingRefresh;

  assert.equal(browser.element('requested-quantity').textContent, '—');
  assert.equal(browser.element('strategy-state').textContent, '—');
  assert.equal(browser.element('spot-actual-fill').textContent, '0');
  assert.doesNotMatch(
    browser.element('spot-order-ids').children[0]?.textContent ?? '',
    /stale-sentinel/
  );
  assert.equal(browser.element('risk-ack').checked, false);
  assert.equal(browser.element('confirm-button').disabled, true);
  assert.equal(browser.element('refresh-button').disabled, true);
});

test('operator UI ignores a delayed preflight response after an input edit', async () => {
  const browser = await browserHarness();
  let resolvePreflight: ((response: FakeBrowserResponse) => void) | undefined;
  const delayedPreflight = new Promise<FakeBrowserResponse>((resolve) => {
    resolvePreflight = resolve;
  });
  browser.setFetch(async (url) => {
    assert.equal(url, '/api/hedges/preflight');
    return delayedPreflight;
  });

  const pendingSubmission = browser.element('preflight-form').emit('submit');
  await flushImmediate();
  browser.element('base-quantity').value = '2';
  await browser.element('base-quantity').emit('input');
  resolvePreflight?.(browserResponse(201, browserPreflightResponse()));
  await pendingSubmission;

  assert.equal(browser.element('requested-quantity').textContent, '—');
  assert.equal(browser.element('strategy-state').textContent, '—');
  assert.equal(browser.element('risk-ack').checked, false);
  assert.equal(browser.element('confirm-button').disabled, true);
  assert.equal(browser.element('refresh-button').disabled, true);
});

test('operator UI admits only one confirmation request across a double click', async () => {
  const browser = await browserHarness();
  browser.setFetch(async (url) => {
    assert.equal(url, '/api/hedges/preflight');
    return browserResponse(201, browserPreflightResponse());
  });
  await browser.element('preflight-form').emit('submit');
  browser.element('risk-ack').checked = true;
  await browser.element('risk-ack').emit('change');
  assert.equal(browser.element('confirm-button').disabled, false);

  let resolveConfirmation:
    | ((response: FakeBrowserResponse) => void)
    | undefined;
  const delayedConfirmation = new Promise<FakeBrowserResponse>((resolve) => {
    resolveConfirmation = resolve;
  });
  browser.setFetch(async (url) => {
    assert.equal(
      url,
      '/api/hedges/strategy-browser-1/confirm'
    );
    return delayedConfirmation;
  });

  const firstClick = browser.element('confirm-button').emit('click');
  const secondClick = browser.element('confirm-button').emit('click');
  await flushImmediate();
  assert.equal(
    browser.fetchCalls.filter(({ url }) => url.endsWith('/confirm')).length,
    1
  );
  assert.equal(browser.element('confirm-button').disabled, true);

  resolveConfirmation?.(browserResponse(202, { accepted: true }));
  await Promise.all([firstClick, secondClick]);
  assert.equal(browser.element('confirm-button').disabled, true);
});

test('operator UI loads an EXECUTING strategy and requires a fresh acknowledgement to resume', async () => {
  const browser = await browserHarness();
  const strategyId = '123e4567-e89b-42d3-a456-426614174000';
  const status = browserStatusResponse();
  Object.assign(status.strategy as Record<string, unknown>, {
    id: strategyId,
    mode: 'CONTRACT_FIRST'
  });
  (status.preflight as Record<string, unknown>).mode = 'CONTRACT_FIRST';
  const plannedIntent = browserOrderResponse(
    strategyId,
    'CONTRACT_MARKET'
  );
  plannedIntent.exchangeOrderId = null;
  plannedIntent.snapshot = null;
  plannedIntent.status = 'planned';
  status.orders = [plannedIntent];
  browser.element('resume-strategy-id').value = strategyId;
  browser.setFetch(async (url, options) => {
    if (url === `/api/hedges/${strategyId}`) {
      assert.equal(options, undefined);
      return browserResponse(200, status);
    }
    if (url === `/api/hedges/${strategyId}/confirm`) {
      assert.equal(options?.method, 'POST');
      assert.equal(
        options?.body,
        JSON.stringify({ riskAcknowledged: true })
      );
      return browserResponse(202, { accepted: true });
    }
    throw new Error(`unexpected resume URL: ${url}`);
  });

  await browser.element('resume-form').emit('submit');

  assert.equal(browser.element('strategy-state').textContent, 'EXECUTING');
  assert.equal(browser.element('strategy-id').textContent, strategyId);
  assert.equal(browser.element('spot-exchange').value, 'bitget');
  assert.equal(browser.element('contract-exchange').value, 'okx');
  assert.equal(browser.element('symbol').value, SYMBOL);
  assert.equal(browser.element('base-quantity').value, '1');
  assert.equal(browser.element('mode').value, 'CONTRACT_FIRST');
  assert.equal(browser.element('risk-ack').checked, false);
  assert.equal(browser.element('confirm-button').disabled, true);
  assert.equal(browser.element('refresh-button').disabled, false);

  browser.element('risk-ack').checked = true;
  await browser.element('risk-ack').emit('change');
  assert.equal(browser.element('confirm-button').disabled, false);
  await browser.element('confirm-button').emit('click');
  assert.equal(
    browser.fetchCalls.filter(({ url }) => url.endsWith('/confirm')).length,
    1
  );
  assert.equal(browser.element('risk-ack').checked, false);
  assert.equal(browser.element('confirm-button').disabled, true);
});

test('operator UI loads and actually confirms a concurrent single-market recovery intent', async () => {
  const browser = await browserHarness();
  const strategyId = '123e4567-e89b-42d3-a456-426614174009';
  const status = browserStatusResponse();
  Object.assign(status.strategy as Record<string, unknown>, {
    id: strategyId,
    mode: 'CONCURRENT',
    state: 'EXECUTING'
  });
  const plannedIntent = browserOrderResponse(strategyId, 'SPOT_MARKET');
  plannedIntent.exchangeOrderId = null;
  plannedIntent.snapshot = null;
  plannedIntent.status = 'planned';
  status.orders = [plannedIntent];
  browser.element('resume-strategy-id').value = strategyId;
  browser.setFetch(async (url, options) => {
    if (url === `/api/hedges/${strategyId}`) {
      assert.equal(options, undefined);
      return browserResponse(200, status);
    }
    if (url === `/api/hedges/${strategyId}/confirm`) {
      assert.equal(options?.method, 'POST');
      assert.equal(
        options?.body,
        JSON.stringify({ riskAcknowledged: true })
      );
      return browserResponse(202, { accepted: true });
    }
    throw new Error(`unexpected single-intent URL: ${url}`);
  });

  await browser.element('resume-form').emit('submit');
  assert.equal(browser.element('strategy-state').textContent, 'EXECUTING');
  assert.equal(browser.element('risk-ack').checked, false);
  assert.equal(browser.element('confirm-button').disabled, true);

  browser.element('risk-ack').checked = true;
  await browser.element('risk-ack').emit('change');
  assert.equal(browser.element('confirm-button').disabled, false);
  await browser.element('confirm-button').emit('click');

  assert.equal(
    browser.fetchCalls.filter(({ url }) => url.endsWith('/confirm')).length,
    1
  );
  assert.equal(browser.element('risk-ack').checked, false);
  assert.equal(browser.element('confirm-button').disabled, true);
});

test('operator UI renders equal canceled-positive concurrent markets as HEDGED', async () => {
  const browser = await browserHarness();
  const strategyId = '123e4567-e89b-42d3-a456-426614174010';
  const status = browserStatusResponse();
  Object.assign(status.strategy as Record<string, unknown>, {
    id: strategyId,
    mode: 'CONCURRENT',
    state: 'HEDGED'
  });
  const spot = browserOrderResponse(
    strategyId,
    'SPOT_MARKET',
    '423e4567-e89b-42d3-a456-426614174010'
  );
  const contract = browserOrderResponse(
    strategyId,
    'CONTRACT_MARKET',
    '423e4567-e89b-42d3-a456-426614174011'
  );
  for (const order of [spot, contract]) {
    setBrowserOrderSnapshot(order, {
      filledBaseQuantity: '0.6',
      remainingBaseQuantity: '0.4',
      averagePrice: null,
      status: 'canceled'
    });
  }
  status.orders = [spot, contract];
  setBrowserActualFills(status, '0.6', '0.6', '0');
  browser.element('resume-strategy-id').value = strategyId;
  browser.setFetch(async (url) => {
    assert.equal(url, `/api/hedges/${strategyId}`);
    return browserResponse(200, status);
  });

  await browser.element('resume-form').emit('submit');

  assert.equal(browser.element('strategy-state').textContent, 'HEDGED');
  assert.equal(browser.element('spot-actual-fill').textContent, '0.6');
  assert.equal(browser.element('contract-actual-fill').textContent, '0.6');
  assert.equal(browser.element('confirm-button').disabled, true);
});

test('operator UI trusts a concurrent difference when only the larger market has an average', async () => {
  const browser = await browserHarness();
  const strategyId = '123e4567-e89b-42d3-a456-426614174015';
  const status = browserStatusResponse();
  Object.assign(status.strategy as Record<string, unknown>, {
    id: strategyId,
    mode: 'CONCURRENT',
    state: 'WAITING_HEDGE'
  });
  const spot = browserOrderResponse(
    strategyId,
    'SPOT_MARKET',
    '423e4567-e89b-42d3-a456-426614174015'
  );
  setBrowserOrderSnapshot(spot, {
    filledBaseQuantity: '0.7',
    remainingBaseQuantity: '0.3',
    averagePrice: '61234',
    status: 'canceled'
  });
  const contract = browserOrderResponse(
    strategyId,
    'CONTRACT_MARKET',
    '423e4567-e89b-42d3-a456-426614174016'
  );
  setBrowserOrderSnapshot(contract, {
    filledBaseQuantity: '0',
    remainingBaseQuantity: '1',
    averagePrice: null,
    status: 'canceled'
  });
  const hedge = browserOrderResponse(
    strategyId,
    'CONTRACT_HEDGE_GTC',
    '423e4567-e89b-42d3-a456-426614174017',
    '0.7'
  );
  setBrowserOrderSnapshot(hedge, {
    filledBaseQuantity: '0',
    remainingBaseQuantity: '0.7',
    averagePrice: null,
    status: 'open'
  });
  status.orders = [spot, contract, hedge];
  setBrowserActualFills(status, '0.7', '0', '0.7');
  browser.element('resume-strategy-id').value = strategyId;
  browser.setFetch(async (url) => {
    assert.equal(url, `/api/hedges/${strategyId}`);
    return browserResponse(200, status);
  });

  await browser.element('resume-form').emit('submit');

  assert.equal(browser.element('strategy-state').textContent, 'WAITING_HEDGE');
  assert.equal(browser.element('spot-actual-fill').textContent, '0.7');
  assert.equal(browser.element('contract-actual-fill').textContent, '0');
});

test('operator UI rejects a concurrent difference when the larger market average is missing', async () => {
  const browser = await browserHarness();
  const strategyId = '123e4567-e89b-42d3-a456-426614174018';
  const status = browserStatusResponse();
  Object.assign(status.strategy as Record<string, unknown>, {
    id: strategyId,
    mode: 'CONCURRENT',
    state: 'WAITING_HEDGE'
  });
  const spot = browserOrderResponse(
    strategyId,
    'SPOT_MARKET',
    '423e4567-e89b-42d3-a456-426614174018'
  );
  setBrowserOrderSnapshot(spot, {
    filledBaseQuantity: '0.7',
    remainingBaseQuantity: '0.3',
    averagePrice: null,
    status: 'closed'
  });
  const contract = browserOrderResponse(
    strategyId,
    'CONTRACT_MARKET',
    '423e4567-e89b-42d3-a456-426614174019'
  );
  setBrowserOrderSnapshot(contract, {
    filledBaseQuantity: '0.2',
    remainingBaseQuantity: '0.8',
    averagePrice: '61235',
    status: 'closed'
  });
  const hedge = browserOrderResponse(
    strategyId,
    'CONTRACT_HEDGE_GTC',
    '423e4567-e89b-42d3-a456-426614174020',
    '0.5'
  );
  setBrowserOrderSnapshot(hedge, {
    filledBaseQuantity: '0',
    remainingBaseQuantity: '0.5',
    averagePrice: null,
    status: 'open'
  });
  status.orders = [spot, contract, hedge];
  setBrowserActualFills(status, '0.7', '0.2', '0.5');
  browser.element('resume-strategy-id').value = strategyId;
  browser.setFetch(async () => browserResponse(200, status));

  await browser.element('resume-form').emit('submit');

  assert.equal(browser.element('strategy-state').textContent, '—');
  assert.equal(browser.element('refresh-button').disabled, true);
});

test('operator UI rejects a one-way preflight response as non-actionable', async () => {
  const browser = await browserHarness();
  const body = browserPreflightResponse();
  const preview = body.preflight as Record<string, unknown>;
  (preview.accountSettings as Record<string, unknown>).positionMode = 'one-way';
  browser.setFetch(async (url) => {
    assert.equal(url, '/api/hedges/preflight');
    return browserResponse(201, body);
  });

  await browser.element('preflight-form').emit('submit');

  assert.equal(browser.element('strategy-state').textContent, '—');
  assert.equal(browser.element('risk-ack').checked, false);
  assert.equal(browser.element('confirm-button').disabled, true);
  assert.equal(browser.element('refresh-button').disabled, true);
});

test('operator UI loads WAITING_HEDGE for observation without enabling confirmation', async () => {
  const browser = await browserHarness();
  const strategyId = '123e4567-e89b-42d3-a456-426614174001';
  const status = browserContractFirstWaitingStatus(strategyId);
  browser.element('resume-strategy-id').value = strategyId;
  browser.setFetch(async (url) => {
    assert.equal(url, `/api/hedges/${strategyId}`);
    return browserResponse(200, status);
  });

  await browser.element('resume-form').emit('submit');
  assert.equal(
    browser.element('strategy-state').textContent,
    'WAITING_HEDGE'
  );
  assert.equal(browser.element('refresh-button').disabled, false);
  browser.element('risk-ack').checked = true;
  await browser.element('risk-ack').emit('change');
  assert.equal(browser.element('confirm-button').disabled, true);
});

test('operator UI disables recovery confirmation when refresh reaches WAITING_HEDGE', async () => {
  const browser = await browserHarness();
  const strategyId = '123e4567-e89b-42d3-a456-426614174008';
  const executing = browserStatusResponse();
  Object.assign(executing.strategy as Record<string, unknown>, {
    id: strategyId,
    mode: 'CONTRACT_FIRST'
  });
  (executing.preflight as Record<string, unknown>).mode = 'CONTRACT_FIRST';
  browser.element('resume-strategy-id').value = strategyId;
  let status = executing;
  browser.setFetch(async (url) => {
    assert.equal(url, `/api/hedges/${strategyId}`);
    return browserResponse(200, status);
  });
  await browser.element('resume-form').emit('submit');
  browser.element('risk-ack').checked = true;
  await browser.element('risk-ack').emit('change');
  assert.equal(browser.element('confirm-button').disabled, false);

  const waiting = browserContractFirstWaitingStatus(strategyId);
  status = waiting;
  await browser.element('refresh-button').emit('click');

  assert.equal(
    browser.element('strategy-state').textContent,
    'WAITING_HEDGE'
  );
  assert.equal(browser.element('risk-ack').checked, false);
  assert.equal(browser.element('confirm-button').disabled, true);
});

test('operator UI rejects an invalid or internally inconsistent loaded strategy', async (t) => {
  const strategyId = '123e4567-e89b-42d3-a456-426614174002';
  const cases = [
    {
      name: 'response id mismatch',
      mutate(body: Record<string, unknown>): void {
        (body.strategy as Record<string, unknown>).id =
          '123e4567-e89b-42d3-a456-426614174099';
      }
    },
    {
      name: 'strategy and preflight identity mismatch',
      mutate(body: Record<string, unknown>): void {
        (body.strategy as Record<string, unknown>).symbol = 'ETH/USDT';
      }
    },
    {
      name: 'self-consistent unsupported exchange',
      mutate(body: Record<string, unknown>): void {
        (body.strategy as Record<string, unknown>).spotExchangeId = 'kraken';
        (body.preflight as Record<string, unknown>).spotExchangeId = 'kraken';
      }
    },
    {
      name: 'non-actionable preflight',
      mutate(body: Record<string, unknown>): void {
        const preview = body.preflight as Record<string, unknown>;
        const settings = preview.accountSettings as Record<string, unknown>;
        settings.marginMode = 'unknown';
      }
    },
    {
      name: 'invalid actual fills',
      mutate(body: Record<string, unknown>): void {
        const fills = body.actualFills as Record<string, unknown>;
        fills.unmatchedBaseQuantity = '-1';
      }
    },
    {
      name: 'invalid order projection',
      mutate(body: Record<string, unknown>): void {
        body.orders = [{
          role: 'UNSAFE_ROLE',
          clientOrderId: 'client-sentinel',
          exchangeOrderId: 'exchange-sentinel'
        }];
      }
    }
  ];

  for (const item of cases) {
    await t.test(item.name, async () => {
      const browser = await browserHarness();
      const body = browserStatusResponse();
      (body.strategy as Record<string, unknown>).id = strategyId;
      item.mutate(body);
      browser.element('resume-strategy-id').value = strategyId;
      browser.setFetch(async (url) => {
        assert.equal(url, `/api/hedges/${strategyId}`);
        return browserResponse(200, body);
      });

      await browser.element('resume-form').emit('submit');
      assert.equal(browser.element('requested-quantity').textContent, '—');
      assert.equal(browser.element('strategy-state').textContent, '—');
      assert.equal(browser.element('risk-ack').checked, false);
      assert.equal(browser.element('confirm-button').disabled, true);
      assert.equal(browser.element('refresh-button').disabled, true);
    });
  }
});

test('operator UI rejects every malformed full status DTO before enabling confirmation', async (t) => {
  const strategyId = '123e4567-e89b-42d3-a456-426614174009';
  type StatusMutation = {
    readonly name: string;
    mutate(body: Record<string, unknown>): void;
  };
  const oneOrder = (
    body: Record<string, unknown>,
    role: OrderRole = 'SPOT_MARKET'
  ): Record<string, unknown> => {
    const order = browserOrderResponse(strategyId, role);
    body.orders = [order];
    return order;
  };
  const setMode = (
    body: Record<string, unknown>,
    mode: 'CONCURRENT' | 'CONTRACT_FIRST' | 'SPOT_FIRST'
  ): void => {
    (body.strategy as Record<string, unknown>).mode = mode;
    (body.preflight as Record<string, unknown>).mode = mode;
  };
  const cases: StatusMutation[] = [
    {
      name: 'contract-first contains the spot-first market role',
      mutate(body) {
        setMode(body, 'CONTRACT_FIRST');
        oneOrder(body, 'SPOT_MARKET');
      }
    },
    {
      name: 'spot-first contains the contract-first market role',
      mutate(body) {
        setMode(body, 'SPOT_FIRST');
        oneOrder(body, 'CONTRACT_MARKET');
      }
    },
    {
      name: 'concurrent execution contains a hedge before either market',
      mutate(body) {
        oneOrder(body, 'SPOT_HEDGE_GTC');
      }
    },
    {
      name: 'concurrent execution contains a hedge before both markets',
      mutate(body) {
        body.orders = [
          browserOrderResponse(
            strategyId,
            'SPOT_MARKET',
            '223e4567-e89b-42d3-a456-426614174010'
          ),
          browserOrderResponse(
            strategyId,
            'CONTRACT_HEDGE_GTC',
            '223e4567-e89b-42d3-a456-426614174011'
          )
        ];
      }
    },
    {
      name: 'concurrent execution contains two hedge roles',
      mutate(body) {
        body.orders = [
          browserOrderResponse(
            strategyId,
            'SPOT_HEDGE_GTC',
            '223e4567-e89b-42d3-a456-426614174012'
          ),
          browserOrderResponse(
            strategyId,
            'CONTRACT_HEDGE_GTC',
            '223e4567-e89b-42d3-a456-426614174013'
          )
        ];
      }
    },
    {
      name: 'concurrent difference hedge is on the larger fill side',
      mutate(body) {
        const spotMarket = browserOrderResponse(
          strategyId,
          'SPOT_MARKET',
          '223e4567-e89b-42d3-a456-426614174014'
        );
        setBrowserOrderSnapshot(spotMarket, {
          filledBaseQuantity: '1',
          remainingBaseQuantity: '0',
          averagePrice: '60000',
          status: 'closed'
        });
        const contractMarket = browserOrderResponse(
          strategyId,
          'CONTRACT_MARKET',
          '223e4567-e89b-42d3-a456-426614174015'
        );
        setBrowserOrderSnapshot(contractMarket, {
          filledBaseQuantity: '0.4',
          remainingBaseQuantity: '0.6',
          averagePrice: '60010',
          status: 'closed'
        });
        body.orders = [
          spotMarket,
          contractMarket,
          browserOrderResponse(
            strategyId,
            'SPOT_HEDGE_GTC',
            '223e4567-e89b-42d3-a456-426614174016',
            '0.6'
          )
        ];
        setBrowserActualFills(body, '1', '0.4', '0.6');
      }
    },
    {
      name: 'concurrent difference hedge quantity differs from market fills',
      mutate(body) {
        const spotMarket = browserOrderResponse(
          strategyId,
          'SPOT_MARKET',
          '223e4567-e89b-42d3-a456-426614174017'
        );
        setBrowserOrderSnapshot(spotMarket, {
          filledBaseQuantity: '1',
          remainingBaseQuantity: '0',
          averagePrice: '60000',
          status: 'closed'
        });
        const contractMarket = browserOrderResponse(
          strategyId,
          'CONTRACT_MARKET',
          '223e4567-e89b-42d3-a456-426614174018'
        );
        setBrowserOrderSnapshot(contractMarket, {
          filledBaseQuantity: '0.4',
          remainingBaseQuantity: '0.6',
          averagePrice: '60010',
          status: 'closed'
        });
        body.orders = [
          spotMarket,
          contractMarket,
          browserOrderResponse(
            strategyId,
            'CONTRACT_HEDGE_GTC',
            '223e4567-e89b-42d3-a456-426614174019',
            '0.5'
          )
        ];
        setBrowserActualFills(body, '1', '0.4', '0.6');
      }
    },
    {
      name: 'sequential second leg quantity differs from first actual fill',
      mutate(body) {
        setMode(body, 'CONTRACT_FIRST');
        const contractMarket = browserOrderResponse(
          strategyId,
          'CONTRACT_MARKET',
          '223e4567-e89b-42d3-a456-426614174020'
        );
        setBrowserOrderSnapshot(contractMarket, {
          filledBaseQuantity: '0.8',
          remainingBaseQuantity: '0.2',
          averagePrice: '60010',
          status: 'closed'
        });
        body.orders = [
          contractMarket,
          browserOrderResponse(
            strategyId,
            'SPOT_HEDGE_GTC',
            '223e4567-e89b-42d3-a456-426614174021',
            '0.7'
          )
        ];
        setBrowserActualFills(body, '0', '0.8', '0.8');
      }
    },
    {
      name: 'sequential second leg exists before a positive first fill',
      mutate(body) {
        setMode(body, 'CONTRACT_FIRST');
        body.orders = [
          browserOrderResponse(
            strategyId,
            'CONTRACT_MARKET',
            '223e4567-e89b-42d3-a456-426614174022'
          ),
          browserOrderResponse(
            strategyId,
            'SPOT_HEDGE_GTC',
            '223e4567-e89b-42d3-a456-426614174023'
          )
        ];
      }
    },
    {
      name: 'sequential second leg derives from a fill without average price',
      mutate(body) {
        setMode(body, 'CONTRACT_FIRST');
        const contractMarket = browserOrderResponse(
          strategyId,
          'CONTRACT_MARKET',
          '223e4567-e89b-42d3-a456-426614174024'
        );
        setBrowserOrderSnapshot(contractMarket, {
          filledBaseQuantity: '0.8',
          remainingBaseQuantity: '0.2',
          averagePrice: null,
          status: 'closed'
        });
        body.orders = [
          contractMarket,
          browserOrderResponse(
            strategyId,
            'SPOT_HEDGE_GTC',
            '223e4567-e89b-42d3-a456-426614174025',
            '0.8'
          )
        ];
        setBrowserActualFills(body, '0', '0.8', '0.8');
      }
    },
    {
      name: 'sequential second leg derives from an open first market',
      mutate(body) {
        setMode(body, 'CONTRACT_FIRST');
        const contractMarket = browserOrderResponse(
          strategyId,
          'CONTRACT_MARKET',
          '223e4567-e89b-42d3-a456-426614174026'
        );
        setBrowserOrderSnapshot(contractMarket, {
          filledBaseQuantity: '0.8',
          remainingBaseQuantity: '0.2',
          averagePrice: '60010',
          status: 'open'
        });
        body.orders = [
          contractMarket,
          browserOrderResponse(
            strategyId,
            'SPOT_HEDGE_GTC',
            '223e4567-e89b-42d3-a456-426614174027',
            '0.8'
          )
        ];
        setBrowserActualFills(body, '0', '0.8', '0.8');
      }
    },
    {
      name: 'concurrent difference hedge derives from a nonclosed market',
      mutate(body) {
        const spotMarket = browserOrderResponse(
          strategyId,
          'SPOT_MARKET',
          '223e4567-e89b-42d3-a456-426614174028'
        );
        setBrowserOrderSnapshot(spotMarket, {
          filledBaseQuantity: '1',
          remainingBaseQuantity: '0',
          averagePrice: '60000',
          status: 'closed'
        });
        const contractMarket = browserOrderResponse(
          strategyId,
          'CONTRACT_MARKET',
          '223e4567-e89b-42d3-a456-426614174029'
        );
        setBrowserOrderSnapshot(contractMarket, {
          filledBaseQuantity: '0.4',
          remainingBaseQuantity: '0.6',
          averagePrice: '60010',
          status: 'open'
        });
        body.orders = [
          spotMarket,
          contractMarket,
          browserOrderResponse(
            strategyId,
            'CONTRACT_HEDGE_GTC',
            '223e4567-e89b-42d3-a456-426614174030',
            '0.6'
          )
        ];
        setBrowserActualFills(body, '1', '0.4', '0.6');
      }
    },
    {
      name: 'concurrent equal market fills contain a difference hedge',
      mutate(body) {
        const spotMarket = browserOrderResponse(
          strategyId,
          'SPOT_MARKET',
          '223e4567-e89b-42d3-a456-426614174031'
        );
        setBrowserOrderSnapshot(spotMarket, {
          filledBaseQuantity: '0.5',
          remainingBaseQuantity: '0.5',
          averagePrice: '60000',
          status: 'closed'
        });
        const contractMarket = browserOrderResponse(
          strategyId,
          'CONTRACT_MARKET',
          '223e4567-e89b-42d3-a456-426614174032'
        );
        setBrowserOrderSnapshot(contractMarket, {
          filledBaseQuantity: '0.5',
          remainingBaseQuantity: '0.5',
          averagePrice: '60010',
          status: 'closed'
        });
        body.orders = [
          spotMarket,
          contractMarket,
          browserOrderResponse(
            strategyId,
            'CONTRACT_HEDGE_GTC',
            '223e4567-e89b-42d3-a456-426614174033',
            '0.1'
          )
        ];
        setBrowserActualFills(body, '0.5', '0.5', '0');
      }
    },
    {
      name: 'hedged state has unequal positive actual exposure',
      mutate(body) {
        (body.strategy as Record<string, unknown>).state = 'HEDGED';
        const spotMarket = browserOrderResponse(
          strategyId,
          'SPOT_MARKET',
          '223e4567-e89b-42d3-a456-426614174034'
        );
        setBrowserOrderSnapshot(spotMarket, {
          filledBaseQuantity: '1',
          remainingBaseQuantity: '0',
          averagePrice: '60000',
          status: 'closed'
        });
        const contractMarket = browserOrderResponse(
          strategyId,
          'CONTRACT_MARKET',
          '223e4567-e89b-42d3-a456-426614174035'
        );
        setBrowserOrderSnapshot(contractMarket, {
          filledBaseQuantity: '0.4',
          remainingBaseQuantity: '0.6',
          averagePrice: '60010',
          status: 'closed'
        });
        body.orders = [spotMarket, contractMarket];
        setBrowserActualFills(body, '1', '0.4', '0.6');
      }
    },
    {
      name: 'hedged state has no positive actual exposure',
      mutate(body) {
        (body.strategy as Record<string, unknown>).state = 'HEDGED';
        body.orders = [
          browserOrderResponse(
            strategyId,
            'SPOT_MARKET',
            '223e4567-e89b-42d3-a456-426614174036'
          ),
          browserOrderResponse(
            strategyId,
            'CONTRACT_MARKET',
            '223e4567-e89b-42d3-a456-426614174037'
          )
        ];
      }
    },
    {
      name: 'waiting state contains a fully closed difference hedge',
      mutate(body) {
        (body.strategy as Record<string, unknown>).state = 'WAITING_HEDGE';
        const spotMarket = browserOrderResponse(
          strategyId,
          'SPOT_MARKET',
          '223e4567-e89b-42d3-a456-426614174038'
        );
        setBrowserOrderSnapshot(spotMarket, {
          filledBaseQuantity: '1',
          remainingBaseQuantity: '0',
          averagePrice: '60000',
          status: 'closed'
        });
        const contractMarket = browserOrderResponse(
          strategyId,
          'CONTRACT_MARKET',
          '223e4567-e89b-42d3-a456-426614174039'
        );
        setBrowserOrderSnapshot(contractMarket, {
          filledBaseQuantity: '0.4',
          remainingBaseQuantity: '0.6',
          averagePrice: '60010',
          status: 'closed'
        });
        const contractHedge = browserOrderResponse(
          strategyId,
          'CONTRACT_HEDGE_GTC',
          '223e4567-e89b-42d3-a456-426614174040',
          '0.6'
        );
        setBrowserOrderSnapshot(contractHedge, {
          filledBaseQuantity: '0.6',
          remainingBaseQuantity: '0',
          averagePrice: '60000',
          status: 'closed'
        });
        body.orders = [spotMarket, contractMarket, contractHedge];
        setBrowserActualFills(body, '1', '1', '0');
      }
    },
    {
      name: 'strategy effective quantity differs from preflight',
      mutate(body) {
        (body.strategy as Record<string, unknown>).effectiveBaseQuantity = '2';
      }
    },
    {
      name: 'nonfailure strategy state carries a failure code',
      mutate(body) {
        (body.strategy as Record<string, unknown>).failureCode = 'NO_FILL';
      }
    },
    {
      name: 'strategy update time precedes creation',
      mutate(body) {
        (body.strategy as Record<string, unknown>).updatedAt =
          '2026-07-30T23:59:59.000Z';
      }
    },
    {
      name: 'preflight spot market identity differs',
      mutate(body) {
        const preview = body.preflight as Record<string, unknown>;
        (preview.spotMarket as Record<string, unknown>).exchangeId = 'okx';
      }
    },
    {
      name: 'preflight contract market kind differs',
      mutate(body) {
        const preview = body.preflight as Record<string, unknown>;
        (preview.contractMarket as Record<string, unknown>).kind = 'spot';
      }
    },
    {
      name: 'preflight creation time is not canonical',
      mutate(body) {
        (body.preflight as Record<string, unknown>).createdAt = 'yesterday';
      }
    },
    {
      name: 'order strategy id differs',
      mutate(body) {
        oneOrder(body).strategyId =
          '123e4567-e89b-42d3-a456-426614174099';
      }
    },
    {
      name: 'order exchange differs from its role',
      mutate(body) {
        oneOrder(body).exchangeId = 'okx';
      }
    },
    {
      name: 'order request is missing',
      mutate(body) {
        delete oneOrder(body).request;
      }
    },
    {
      name: 'order snapshot is missing for an open order',
      mutate(body) {
        oneOrder(body).snapshot = null;
      }
    },
    {
      name: 'order status differs from snapshot',
      mutate(body) {
        oneOrder(body).status = 'closed';
      }
    },
    {
      name: 'order timestamp is not canonical',
      mutate(body) {
        oneOrder(body).createdAt = 'not-a-time';
      }
    },
    {
      name: 'client order id has invalid format',
      mutate(body) {
        const order = oneOrder(body);
        order.clientOrderId = 'client-id';
        (order.request as Record<string, unknown>).clientOrderId = 'client-id';
        (order.snapshot as Record<string, unknown>).clientOrderId = 'client-id';
      }
    },
    {
      name: 'client order id is formatted but not deterministic',
      mutate(body) {
        const order = oneOrder(body);
        const wrongId = '0'.repeat(32);
        order.clientOrderId = wrongId;
        (order.request as Record<string, unknown>).clientOrderId = wrongId;
        (order.snapshot as Record<string, unknown>).clientOrderId = wrongId;
      }
    },
    {
      name: 'duplicate order role',
      mutate(body) {
        body.orders = [
          browserOrderResponse(
            strategyId,
            'SPOT_MARKET',
            '223e4567-e89b-42d3-a456-426614174001'
          ),
          browserOrderResponse(
            strategyId,
            'SPOT_MARKET',
            '223e4567-e89b-42d3-a456-426614174002'
          )
        ];
      }
    },
    {
      name: 'duplicate client id across roles',
      mutate(body) {
        const first = browserOrderResponse(
          strategyId,
          'SPOT_MARKET',
          '223e4567-e89b-42d3-a456-426614174003'
        );
        const second = browserOrderResponse(
          strategyId,
          'CONTRACT_MARKET',
          '223e4567-e89b-42d3-a456-426614174004'
        );
        const duplicateId = first.clientOrderId;
        second.clientOrderId = duplicateId;
        (second.request as Record<string, unknown>).clientOrderId = duplicateId;
        (second.snapshot as Record<string, unknown>).clientOrderId = duplicateId;
        body.orders = [first, second];
      }
    },
    {
      name: 'spot role request uses swap kind',
      mutate(body) {
        const order = oneOrder(body);
        (order.request as Record<string, unknown>).kind = 'swap';
        (order.snapshot as Record<string, unknown>).kind = 'swap';
      }
    },
    {
      name: 'market role request uses limit type',
      mutate(body) {
        const order = oneOrder(body);
        (order.request as Record<string, unknown>).type = 'limit';
        (order.snapshot as Record<string, unknown>).type = 'limit';
      }
    },
    {
      name: 'spot role request uses sell side',
      mutate(body) {
        const order = oneOrder(body);
        (order.request as Record<string, unknown>).side = 'sell';
        (order.snapshot as Record<string, unknown>).side = 'sell';
      }
    },
    {
      name: 'spot request carries contract position side',
      mutate(body) {
        (oneOrder(body).request as Record<string, unknown>).positionSide =
          'SHORT';
      }
    },
    {
      name: 'GTC hedge omits time in force',
      mutate(body) {
        const order = oneOrder(body, 'SPOT_HEDGE_GTC');
        delete (order.request as Record<string, unknown>).timeInForce;
      }
    },
    {
      name: 'snapshot symbol differs from request',
      mutate(body) {
        (oneOrder(body).snapshot as Record<string, unknown>).symbol =
          'ETH/USDT';
      }
    },
    {
      name: 'snapshot client id differs from order',
      mutate(body) {
        (oneOrder(body).snapshot as Record<string, unknown>).clientOrderId =
          'f'.repeat(32);
      }
    },
    {
      name: 'snapshot exchange differs from order',
      mutate(body) {
        (oneOrder(body).snapshot as Record<string, unknown>).exchangeId = 'okx';
      }
    },
    {
      name: 'snapshot exchange order id differs from order',
      mutate(body) {
        (oneOrder(body).snapshot as Record<string, unknown>).exchangeOrderId =
          'other-exchange-order';
      }
    },
    {
      name: 'snapshot quantities do not sum to request',
      mutate(body) {
        (oneOrder(body).snapshot as Record<string, unknown>)
          .remainingBaseQuantity = '0.5';
      }
    }
  ];

  for (const item of cases) {
    await t.test(item.name, async () => {
      const browser = await browserHarness();
      const body = browserStatusResponse();
      (body.strategy as Record<string, unknown>).id = strategyId;
      item.mutate(body);
      browser.element('resume-strategy-id').value = strategyId;
      browser.setFetch(async (url) => {
        if (url === `/api/hedges/${strategyId}`) {
          return browserResponse(200, body);
        }
        if (url === `/api/hedges/${strategyId}/confirm`) {
          return browserResponse(202, { accepted: true });
        }
        throw new Error(`unexpected malformed-status URL: ${url}`);
      });

      await browser.element('resume-form').emit('submit');
      browser.element('risk-ack').checked = true;
      await browser.element('risk-ack').emit('change');
      await browser.element('confirm-button').emit('click');
      assert.equal(
        browser.fetchCalls.filter(({ url }) => url.endsWith('/confirm')).length,
        0
      );
      assert.equal(browser.element('requested-quantity').textContent, '—');
      assert.equal(browser.element('strategy-state').textContent, '—');
      assert.equal(browser.element('risk-ack').checked, true);
      assert.equal(browser.element('confirm-button').disabled, true);
      assert.equal(browser.element('refresh-button').disabled, true);
    });
  }
});

test('operator UI preserves every reachable or diagnostic mode-state topology', async (t) => {
  const strategyId = '123e4567-e89b-42d3-a456-426614174014';
  type TopologyCase = {
    readonly name: string;
    readonly mode: 'CONCURRENT' | 'CONTRACT_FIRST' | 'SPOT_FIRST';
    readonly state:
      | 'PENDING_CONFIRMATION'
      | 'EXECUTING'
      | 'WAITING_HEDGE'
      | 'HEDGED'
      | 'HEDGE_INCOMPLETE'
      | 'FAILED';
    readonly roles: readonly OrderRole[];
    readonly quantities?: Partial<Record<OrderRole, string>>;
    readonly snapshots?: Partial<
      Record<OrderRole, Partial<OrderSnapshot>>
    >;
    readonly actualFills?: {
      readonly spot: string;
      readonly contract: string;
      readonly unmatched: string;
    };
    readonly actionable: boolean;
  };
  const cases: readonly TopologyCase[] = [
    {
      name: 'pending without orders',
      mode: 'CONCURRENT',
      state: 'PENDING_CONFIRMATION',
      roles: [],
      actionable: true
    },
    ...([
      ['CONTRACT_FIRST', []],
      ['CONTRACT_FIRST', ['CONTRACT_MARKET']],
      ['SPOT_FIRST', []],
      ['SPOT_FIRST', ['SPOT_MARKET']],
      ['CONCURRENT', []],
      ['CONCURRENT', ['SPOT_MARKET']],
      ['CONCURRENT', ['CONTRACT_MARKET']]
    ] as const).map(([mode, roles]) => ({
      name: `executing ${mode} with ${roles.join(',') || 'no orders'}`,
      mode,
      state: 'EXECUTING' as const,
      roles,
      actionable: true
    })),
    {
      name: 'executing contract-first with a derived spot second leg',
      mode: 'CONTRACT_FIRST',
      state: 'EXECUTING',
      roles: ['CONTRACT_MARKET', 'SPOT_HEDGE_GTC'],
      quantities: { SPOT_HEDGE_GTC: '0.6' },
      snapshots: {
        CONTRACT_MARKET: {
          filledBaseQuantity: '0.6',
          remainingBaseQuantity: '0.4',
          averagePrice: '60010',
          status: 'closed'
        }
      },
      actualFills: { spot: '0', contract: '0.6', unmatched: '0.6' },
      actionable: true
    },
    {
      name: 'executing spot-first with a derived contract second leg',
      mode: 'SPOT_FIRST',
      state: 'EXECUTING',
      roles: ['SPOT_MARKET', 'CONTRACT_HEDGE_GTC'],
      quantities: { CONTRACT_HEDGE_GTC: '0.7' },
      snapshots: {
        SPOT_MARKET: {
          filledBaseQuantity: '0.7',
          remainingBaseQuantity: '0.3',
          averagePrice: '60000',
          status: 'closed'
        }
      },
      actualFills: { spot: '0.7', contract: '0', unmatched: '0.7' },
      actionable: true
    },
    {
      name: 'executing concurrent with equal positive market fills',
      mode: 'CONCURRENT',
      state: 'EXECUTING',
      roles: ['SPOT_MARKET', 'CONTRACT_MARKET'],
      snapshots: {
        SPOT_MARKET: {
          filledBaseQuantity: '0.8',
          remainingBaseQuantity: '0.2',
          averagePrice: '60000',
          status: 'closed'
        },
        CONTRACT_MARKET: {
          filledBaseQuantity: '0.8',
          remainingBaseQuantity: '0.2',
          averagePrice: '60010',
          status: 'closed'
        }
      },
      actualFills: { spot: '0.8', contract: '0.8', unmatched: '0' },
      actionable: true
    },
    {
      name: 'executing concurrent preserves an exact tiny contract hedge',
      mode: 'CONCURRENT',
      state: 'EXECUTING',
      roles: ['SPOT_MARKET', 'CONTRACT_MARKET', 'CONTRACT_HEDGE_GTC'],
      quantities: {
        CONTRACT_HEDGE_GTC:
          '0.0000000000000000000000000000000000000001'
      },
      snapshots: {
        SPOT_MARKET: {
          filledBaseQuantity:
            '0.5000000000000000000000000000000000000001',
          remainingBaseQuantity:
            '0.4999999999999999999999999999999999999999',
          averagePrice: '60000',
          status: 'closed'
        },
        CONTRACT_MARKET: {
          filledBaseQuantity: '0.5',
          remainingBaseQuantity: '0.5',
          averagePrice: '60010',
          status: 'closed'
        }
      },
      actualFills: {
        spot: '0.5000000000000000000000000000000000000001',
        contract: '0.5',
        unmatched: '0.0000000000000000000000000000000000000001'
      },
      actionable: true
    },
    {
      name: 'executing concurrent hedges the smaller spot fill',
      mode: 'CONCURRENT',
      state: 'EXECUTING',
      roles: ['SPOT_MARKET', 'CONTRACT_MARKET', 'SPOT_HEDGE_GTC'],
      quantities: { SPOT_HEDGE_GTC: '0.6' },
      snapshots: {
        SPOT_MARKET: {
          filledBaseQuantity: '0.4',
          remainingBaseQuantity: '0.6',
          averagePrice: '60000',
          status: 'closed'
        },
        CONTRACT_MARKET: {
          filledBaseQuantity: '1',
          remainingBaseQuantity: '0',
          averagePrice: '60010',
          status: 'closed'
        }
      },
      actualFills: { spot: '0.4', contract: '1', unmatched: '0.6' },
      actionable: true
    },
    {
      name: 'waiting contract-first with both sequential roles',
      mode: 'CONTRACT_FIRST',
      state: 'WAITING_HEDGE',
      roles: ['CONTRACT_MARKET', 'SPOT_HEDGE_GTC'],
      quantities: { SPOT_HEDGE_GTC: '0.75' },
      snapshots: {
        CONTRACT_MARKET: {
          filledBaseQuantity: '0.75',
          remainingBaseQuantity: '0.25',
          averagePrice: '60010',
          status: 'closed'
        }
      },
      actualFills: { spot: '0', contract: '0.75', unmatched: '0.75' },
      actionable: false
    },
    {
      name: 'waiting concurrent with both markets and one hedge',
      mode: 'CONCURRENT',
      state: 'WAITING_HEDGE',
      roles: ['SPOT_MARKET', 'CONTRACT_MARKET', 'CONTRACT_HEDGE_GTC'],
      quantities: { CONTRACT_HEDGE_GTC: '0.6' },
      snapshots: {
        SPOT_MARKET: {
          filledBaseQuantity: '1',
          remainingBaseQuantity: '0',
          averagePrice: '60000',
          status: 'closed'
        },
        CONTRACT_MARKET: {
          filledBaseQuantity: '0.4',
          remainingBaseQuantity: '0.6',
          averagePrice: '60010',
          status: 'closed'
        }
      },
      actualFills: { spot: '1', contract: '0.4', unmatched: '0.6' },
      actionable: false
    },
    {
      name: 'hedged spot-first with both sequential roles',
      mode: 'SPOT_FIRST',
      state: 'HEDGED',
      roles: ['SPOT_MARKET', 'CONTRACT_HEDGE_GTC'],
      quantities: { CONTRACT_HEDGE_GTC: '0.8' },
      snapshots: {
        SPOT_MARKET: {
          filledBaseQuantity: '0.8',
          remainingBaseQuantity: '0.2',
          averagePrice: '60000',
          status: 'closed'
        },
        CONTRACT_HEDGE_GTC: {
          filledBaseQuantity: '0.8',
          remainingBaseQuantity: '0',
          averagePrice: '60000',
          status: 'closed'
        }
      },
      actualFills: { spot: '0.8', contract: '0.8', unmatched: '0' },
      actionable: false
    },
    {
      name: 'hedged concurrent with equal market legs and no hedge',
      mode: 'CONCURRENT',
      state: 'HEDGED',
      roles: ['SPOT_MARKET', 'CONTRACT_MARKET'],
      snapshots: {
        SPOT_MARKET: {
          filledBaseQuantity: '0.9',
          remainingBaseQuantity: '0.1',
          averagePrice: '60000',
          status: 'closed'
        },
        CONTRACT_MARKET: {
          filledBaseQuantity: '0.9',
          remainingBaseQuantity: '0.1',
          averagePrice: '60010',
          status: 'closed'
        }
      },
      actualFills: { spot: '0.9', contract: '0.9', unmatched: '0' },
      actionable: false
    },
    {
      name: 'hedged concurrent with both markets and one hedge',
      mode: 'CONCURRENT',
      state: 'HEDGED',
      roles: ['SPOT_MARKET', 'CONTRACT_MARKET', 'SPOT_HEDGE_GTC'],
      quantities: { SPOT_HEDGE_GTC: '0.6' },
      snapshots: {
        SPOT_MARKET: {
          filledBaseQuantity: '0.4',
          remainingBaseQuantity: '0.6',
          averagePrice: '60000',
          status: 'closed'
        },
        CONTRACT_MARKET: {
          filledBaseQuantity: '1',
          remainingBaseQuantity: '0',
          averagePrice: '60010',
          status: 'closed'
        },
        SPOT_HEDGE_GTC: {
          filledBaseQuantity: '0.6',
          remainingBaseQuantity: '0',
          averagePrice: '60000',
          status: 'closed'
        }
      },
      actualFills: { spot: '1', contract: '1', unmatched: '0' },
      actionable: false
    },
    {
      name: 'incomplete contract-first preserves a second-leg-only diagnostic',
      mode: 'CONTRACT_FIRST',
      state: 'HEDGE_INCOMPLETE',
      roles: ['SPOT_HEDGE_GTC'],
      actionable: false
    },
    {
      name: 'failed spot-first preserves a second-leg-only diagnostic',
      mode: 'SPOT_FIRST',
      state: 'FAILED',
      roles: ['CONTRACT_HEDGE_GTC'],
      actionable: false
    },
    {
      name: 'incomplete concurrent preserves a hedge-only diagnostic',
      mode: 'CONCURRENT',
      state: 'HEDGE_INCOMPLETE',
      roles: ['SPOT_HEDGE_GTC'],
      actionable: false
    },
    {
      name: 'failed concurrent preserves one market plus one hedge',
      mode: 'CONCURRENT',
      state: 'FAILED',
      roles: ['SPOT_MARKET', 'CONTRACT_HEDGE_GTC'],
      actionable: false
    }
  ];

  for (const item of cases) {
    await t.test(item.name, async () => {
      const browser = await browserHarness();
      const body = browserStatusResponse();
      Object.assign(body.strategy as Record<string, unknown>, {
        id: strategyId,
        mode: item.mode,
        state: item.state,
        failureCode: ['HEDGE_INCOMPLETE', 'FAILED'].includes(item.state)
          ? 'INCONSISTENT_ORDER_STATE'
          : null
      });
      (body.preflight as Record<string, unknown>).mode = item.mode;
      body.orders = item.roles.map((role, index) => {
        const order = browserOrderResponse(
          strategyId,
          role,
          `323e4567-e89b-42d3-a456-${String(index + 1).padStart(12, '0')}`,
          item.quantities?.[role] ?? '1'
        );
        const snapshot = item.snapshots?.[role];
        if (snapshot !== undefined) {
          setBrowserOrderSnapshot(order, snapshot);
        }
        return order;
      });
      if (item.actualFills !== undefined) {
        setBrowserActualFills(
          body,
          item.actualFills.spot,
          item.actualFills.contract,
          item.actualFills.unmatched
        );
      }
      browser.element('resume-strategy-id').value = strategyId;
      browser.setFetch(async (url) => {
        assert.equal(url, `/api/hedges/${strategyId}`);
        return browserResponse(200, body);
      });

      await browser.element('resume-form').emit('submit');
      assert.equal(browser.element('strategy-state').textContent, item.state);
      assert.equal(browser.element('requested-quantity').textContent, '1');
      assert.equal(browser.element('refresh-button').disabled, false);
      browser.element('risk-ack').checked = true;
      await browser.element('risk-ack').emit('change');
      assert.equal(
        browser.element('confirm-button').disabled,
        !item.actionable
      );
      assert.equal(
        browser.fetchCalls.filter(({ url }) => url.endsWith('/confirm')).length,
        0
      );
    });
  }
});

test('operator UI clears actionable state when strategy loading returns an error', async () => {
  const browser = await browserWithValidPreflight();
  browser.element('risk-ack').checked = true;
  await browser.element('risk-ack').emit('change');
  assert.equal(browser.element('confirm-button').disabled, false);
  const strategyId = '123e4567-e89b-42d3-a456-426614174007';
  browser.element('resume-strategy-id').value = strategyId;
  browser.setFetch(async () => browserResponse(404, {
    code: 'STRATEGY_NOT_FOUND'
  }));

  await browser.element('resume-form').emit('submit');

  assert.equal(browser.element('strategy-state').textContent, '—');
  assert.equal(browser.element('risk-ack').checked, false);
  assert.equal(browser.element('confirm-button').disabled, true);
  assert.equal(browser.element('refresh-button').disabled, true);
});

test('operator UI invalidates a loaded strategy when the resume id is edited', async () => {
  const browser = await browserHarness();
  const strategyId = '123e4567-e89b-42d3-a456-426614174003';
  const status = browserStatusResponse();
  (status.strategy as Record<string, unknown>).id = strategyId;
  browser.element('resume-strategy-id').value = strategyId;
  browser.setFetch(async () => browserResponse(200, status));
  await browser.element('resume-form').emit('submit');
  browser.element('risk-ack').checked = true;
  await browser.element('risk-ack').emit('change');
  assert.equal(browser.element('confirm-button').disabled, false);

  browser.element('resume-strategy-id').value =
    '123e4567-e89b-42d3-a456-426614174004';
  await browser.element('resume-strategy-id').emit('input');

  assert.equal(browser.element('strategy-state').textContent, '—');
  assert.equal(browser.element('risk-ack').checked, false);
  assert.equal(browser.element('confirm-button').disabled, true);
  assert.equal(browser.element('refresh-button').disabled, true);
});

test('operator UI ignores a stale loaded strategy after the resume id changes', async () => {
  const browser = await browserHarness();
  const strategyId = '123e4567-e89b-42d3-a456-426614174005';
  let resolveLoad: ((response: FakeBrowserResponse) => void) | undefined;
  const delayedLoad = new Promise<FakeBrowserResponse>((resolve) => {
    resolveLoad = resolve;
  });
  browser.element('resume-strategy-id').value = strategyId;
  browser.setFetch(async () => delayedLoad);

  const loading = browser.element('resume-form').emit('submit');
  await flushImmediate();
  browser.element('resume-strategy-id').value =
    '123e4567-e89b-42d3-a456-426614174006';
  await browser.element('resume-strategy-id').emit('input');
  const stale = browserStatusResponse();
  (stale.strategy as Record<string, unknown>).id = strategyId;
  resolveLoad?.(browserResponse(200, stale));
  await loading;

  assert.equal(browser.element('strategy-state').textContent, '—');
  assert.equal(browser.element('risk-ack').checked, false);
  assert.equal(browser.element('confirm-button').disabled, true);
  assert.equal(browser.element('refresh-button').disabled, true);
});

test('operator UI rejects a non-canonical resume id before fetching status', async () => {
  const browser = await browserHarness();
  browser.element('resume-strategy-id').value = 'strategy-browser-1';
  browser.setFetch(async () => {
    throw new Error('invalid resume id must not fetch');
  });

  await browser.element('resume-form').emit('submit');

  assert.equal(
    browser.fetchCalls.filter(({ url }) => url.startsWith('/api/hedges/'))
      .length,
    0
  );
  assert.equal(browser.element('strategy-state').textContent, '—');
  assert.equal(browser.element('confirm-button').disabled, true);
});

test('operator page has explicit modes, safe acknowledgement, complete rendering, and invalidation contracts', async (t) => {
  const { server } = setup(t);
  const [pageResponse, scriptResponse, styleResponse] = await Promise.all([
    server.inject({ method: 'GET', url: '/', headers: LOCAL_HEADERS }),
    server.inject({
      method: 'GET',
      url: '/app.js',
      headers: LOCAL_HEADERS
    }),
    server.inject({
      method: 'GET',
      url: '/styles.css',
      headers: LOCAL_HEADERS
    })
  ]);

  assert.equal(pageResponse.statusCode, 200);
  assert.equal(scriptResponse.statusCode, 200);
  assert.equal(styleResponse.statusCode, 200);
  assert.match(pageResponse.headers['content-security-policy'] ?? '', /script-src 'self'/);
  assert.match(pageResponse.headers['cache-control'] ?? '', /no-cache/);

  const page = pageResponse.body;
  const script = scriptResponse.body;
  assert.match(
    page,
    /<option value="" selected disabled>请选择执行模式<\/option>/
  );
  assert.deepEqual(
    [...page.matchAll(/<option value="(CONCURRENT|CONTRACT_FIRST|SPOT_FIRST)">/g)]
      .map((match) => match[1]),
    ['CONCURRENT', 'CONTRACT_FIRST', 'SPOT_FIRST']
  );
  assert.doesNotMatch(
    page,
    /<option value="(?:CONCURRENT|CONTRACT_FIRST|SPOT_FIRST)"[^>]*selected/
  );
  assert.match(page, /我理解顺序模式和差额补单可能长期产生单边敞口/);
  for (const id of [
    'spot-exchange',
    'contract-exchange',
    'symbol',
    'base-quantity',
    'mode',
    'preflight-button',
    'resume-strategy-id',
    'resume-form',
    'load-strategy-button',
    'risk-ack',
    'confirm-button',
    'refresh-button',
    'requested-quantity',
    'effective-quantity',
    'spot-price',
    'contract-price',
    'spot-balance',
    'contract-balance',
    'margin-mode',
    'position-mode',
    'leverage',
    'strategy-id',
    'strategy-state',
    'spot-order-ids',
    'contract-order-ids',
    'spot-actual-fill',
    'contract-actual-fill',
    'unmatched-quantity'
  ]) {
    assert.match(page, new RegExp(`id="${id}"`));
  }
  assert.doesNotMatch(page, /api.?key|secret|password/i);
  assert.match(page, /<link rel="stylesheet" href="\/styles\.css">/);
  assert.match(page, /id="base-quantity"[^>]*maxlength="256"/);
  assert.match(page, /id="resume-strategy-id"[^>]*maxlength="36"/);
  assert.doesNotMatch(script, /innerHTML/);
  assert.match(script, /riskAcknowledged:\s*true/);
  assert.match(script, /input\.addEventListener\('input', invalidatePreflight\)/);
  assert.match(script, /input\.addEventListener\('change', invalidatePreflight\)/);
  assert.match(script, /let inputRevision = 0/);
  assert.match(script, /inputRevision \+= 1/);
  assert.match(script, /const submittedRevision = inputRevision/);
  assert.match(script, /submittedRevision !== inputRevision/);
  assert.match(script, /const statusRevision = inputRevision/);
  assert.match(script, /statusRevision !== inputRevision/);
  assert.match(script, /const confirmationRevision = inputRevision/);
  assert.match(script, /confirmationRevision !== inputRevision/);
  assert.match(script, /strategyId === null/);
  assert.match(script, /确认已受理，正在后台执行/);
  assert.match(script, /\.textContent\s*=/);
});

test('missing strategies use the typed repository error', (t) => {
  const { repository } = setup(t);

  assert.throws(
    () => repository.getStrategy('missing-strategy'),
    StrategyNotFoundError
  );
});
