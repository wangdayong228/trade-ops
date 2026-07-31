/// <reference types="node" />

import assert from 'node:assert/strict';
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
const LOCAL_HEADERS = { host: 'localhost:80' } as const;

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
      positionMode: 'one-way',
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
        positionMode: 'one-way',
        leverage: '2'
      }
    },
    ...overrides
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
      mode: 'CONCURRENT'
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

async function browserHarness(): Promise<BrowserHarness> {
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
  let currentFetch: BrowserFetch = async (url) => {
    if (url === '/api/exchanges') {
      return browserResponse(200, { exchanges: ['bitget', 'okx'] });
    }
    throw new Error(`unexpected browser test URL: ${url}`);
  };
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
    document,
    fetch: async (
      url: string,
      options?: Record<string, unknown>
    ): Promise<FakeBrowserResponse> => {
      fetchCalls.push({ url, options });
      return currentFetch(url, options);
    }
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
      assert.deepEqual(response.json(), {
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
      assert.deepEqual(response.json(), {
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
  assert.deepEqual(wrongScheme.json(), {
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
    assert.deepEqual(response.json(), {
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
      assert.deepEqual(response.json(), {
        code: 'INVALID_REQUEST',
        message: 'Request validation failed'
      });
      assert.doesNotMatch(response.body, /TYPE-SENTINEL/);
    }
  }
  assert.equal(preflightInputs.length, 0);
});

test('preflight failure returns a fixed response without leaking raw errors', async (t) => {
  const { server } = setup(t, {
    runPreflight: async () => {
      throw new Error('apiKey=LEAK-ME-NOT insufficient account 12345');
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
  assert.deepEqual(response.json(), {
    code: 'PREFLIGHT_REJECTED',
    message: 'Preflight checks did not pass'
  });
  assert.doesNotMatch(response.body, /LEAK-ME-NOT|12345/);
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
    assert.deepEqual(response.json(), {
      code: 'INVALID_REQUEST',
      message: 'Request validation failed'
    });
    assert.doesNotMatch(response.body, /TYPE-SENTINEL/);
  }
  await flushImmediate();
  assert.equal(getExecutionCount(), 0);
  assert.equal(repository.getStrategy(strategy.id).state, 'PENDING_CONFIRMATION');
});

test('confirmation returns 404 for an unknown strategy without queueing', async (t) => {
  const { server, getExecutionCount } = setup(t);

  const response = await server.inject({
    method: 'POST',
    url: '/api/hedges/missing-strategy/confirm',
    headers: LOCAL_HEADERS,
    payload: { riskAcknowledged: true }
  });

  assert.equal(response.statusCode, 404);
  assert.deepEqual(response.json(), {
    code: 'STRATEGY_NOT_FOUND',
    message: 'Strategy not found'
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
  let releaseExecution: (() => void) | undefined;
  const executionGate = new Promise<void>((resolve) => {
    releaseExecution = resolve;
  });
  const fixture = setup(t, {
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
  const second = setup(t, { repository: tamperedRepository });

  const tampered = await second.server.inject({
    method: 'GET',
    url: `/api/hedges/${existing.id}`,
    headers: LOCAL_HEADERS
  });

  assert.equal(tampered.statusCode, 500);
  assert.deepEqual(tampered.json(), {
    code: 'INTERNAL_ERROR',
    message: 'Internal server error'
  });
  assert.doesNotMatch(tampered.body, /LEAK-ME-NOT|sqlite row secret/);
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
  browser.setFetch(async (url) => {
    assert.equal(url, '/api/hedges/strategy-browser-1');
    return browserResponse(200, browserStatusResponse({
      orders: [{
        role: 'SPOT_MARKET',
        clientOrderId: 'client-browser-1',
        exchangeOrderId: 'exchange-browser-1'
      }],
      actualFills: {
        spotBuyBaseQuantity: '0',
        contractShortBaseQuantity: highPrecision,
        unmatchedBaseQuantity: highPrecision
      }
    }));
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
    browser.element('spot-order-ids').children[0]?.textContent ?? '',
    /exchange-browser-1/
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

  resolveConfirmation?.(browserResponse(202));
  await Promise.all([firstClick, secondClick]);
  assert.equal(browser.element('confirm-button').disabled, true);
});

test('operator UI loads an EXECUTING strategy and requires a fresh acknowledgement to resume', async () => {
  const browser = await browserHarness();
  const strategyId = '123e4567-e89b-42d3-a456-426614174000';
  const status = browserStatusResponse();
  (status.strategy as Record<string, unknown>).id = strategyId;
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
  assert.equal(browser.element('mode').value, 'CONCURRENT');
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

test('operator UI loads WAITING_HEDGE for observation without enabling confirmation', async () => {
  const browser = await browserHarness();
  const strategyId = '123e4567-e89b-42d3-a456-426614174001';
  const status = browserStatusResponse();
  Object.assign(status.strategy as Record<string, unknown>, {
    id: strategyId,
    state: 'WAITING_HEDGE'
  });
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
  (executing.strategy as Record<string, unknown>).id = strategyId;
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

  const waiting = browserStatusResponse();
  Object.assign(waiting.strategy as Record<string, unknown>, {
    id: strategyId,
    state: 'WAITING_HEDGE'
  });
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
