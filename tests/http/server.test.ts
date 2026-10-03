/// <reference types="node" />

import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Writable } from 'node:stream';
import { tmpdir } from 'node:os';
import test, { type TestContext } from 'node:test';
import { runInNewContext } from 'node:vm';
import Database from 'better-sqlite3';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import { makeClientOrderId } from '../../src/domain/client-order-id.js';
import type {
  OrderRequest,
  OrderRole,
  OrderSnapshot
} from '../../src/domain/types.js';
import {
  createTradeOpsError,
  parseErrorDetail,
  type ErrorDetail
} from '../../src/errors/trade-ops-error.js';
import {
  buildServer,
  LOGGER_REDACT_PATHS
} from '../../src/http/server.js';
import {
  createAppLogger,
  type OperationalFields,
  type OperationalLog
} from '../../src/logging/logger.js';
import type { ConfirmationService } from '../../src/strategy/confirmation-service.js';
import type {
  PreflightInput,
  PreflightResult
} from '../../src/strategy/preflight-service.js';
import { SqliteStrategyRepository } from '../../src/storage/sqlite-strategy-repository.js';
import {
  StrategyNotFoundError,
  type StrategyRepository
} from '../../src/storage/strategy-repository.js';

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
    warn(): void {},
    error(event, error, fields): void {
      entries.push({ event, error, fields });
    },
    fatal(): void {}
  };
}


function completionCapture(): {
  readonly logger: FastifyBaseLogger;
  readonly lines: () => Array<Record<string, unknown>>;
} {
  const output: string[] = [];
  const destination = new Writable({
    write(chunk, _encoding, callback) {
      output.push(String(chunk));
      callback();
    }
  });
  return {
    logger: createAppLogger(destination),
    lines: () => output.join('').trim().split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
  };
}

function completionLines(lines: readonly Record<string, unknown>[]): Array<Record<string, unknown>> {
  return lines.filter((line) => line.msg === 'request completed');
}

function completionForStatus(lines: readonly Record<string, unknown>[], statusCode: number): Record<string, unknown> {
  const matches = completionLines(lines).filter((line) => (line.res as { statusCode?: number } | undefined)?.statusCode === statusCode);
  assert.equal(matches.length, 1, `expected one completion for ${statusCode}`);
  return matches[0] as Record<string, unknown>;
}



function faultingCompletionLogger(
  mode: 'throw' | 'reject'
): FastifyBaseLogger {
  const destination = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    }
  });
  const wrap = (logger: FastifyBaseLogger): FastifyBaseLogger => new Proxy(logger, {
    get(target, property, receiver) {
      if (property === 'child') {
        return (...args: unknown[]) => wrap(
          Reflect.apply(target.child, target, args) as FastifyBaseLogger
        );
      }
      if (property === 'info' || property === 'warn' || property === 'error') {
        return mode === 'throw'
          ? (): never => { throw new Error('completion logger unavailable'); }
          : (): Promise<never> => Promise.reject(
              new Error('completion logger unavailable')
            );
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
  return wrap(createAppLogger(destination));
}

interface PublicErrorExpectation {
  readonly code: string;
  readonly phase?: ErrorDetail['phase'];
  readonly detail?: ErrorDetail;
}

function assertPublicHttpError(
  response: {
    readonly headers: Record<string, string | string[] | number | undefined>;
    json(): Record<string, unknown>;
  },
  expected: Readonly<PublicErrorExpectation>
): ErrorDetail {
  const body = response.json();
  assert.equal(typeof body.requestId, 'string');
  assert.deepEqual(
    Object.keys(body).sort(),
    ['error', 'requestId'],
    'public HTTP errors must contain only requestId and error'
  );
  const detail = parseErrorDetail(body.error);
  assert.equal(detail.code, expected.code);
  if (expected.phase !== undefined) {
    assert.equal(detail.phase, expected.phase);
  }
  if (expected.detail !== undefined) {
    assert.deepEqual(detail, expected.detail);
  }
  assert.match(String(response.headers['cache-control'] ?? ''), /no-store/);
  assert.match(
    String(response.headers['content-security-policy'] ?? ''),
    /default-src 'self'/
  );
  return detail;
}

type TestServerDependencies = Parameters<typeof buildServer>[0] & {
  readonly confirmationService: Pick<ConfirmationService, 'confirm'>;
};

function buildTestServer(
  dependencies: TestServerDependencies
): FastifyInstance {
  return buildServer(dependencies);
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
  readonly confirmationInputs: string[];
  readonly getConfirmationCount: () => number;
  readonly getExecutionCount: () => number;
}

function setup(
  t: TestContext,
  options: {
    readonly repository?: StrategyRepository;
    readonly runPreflight?: (
      input: PreflightInput
    ) => Promise<PreflightResult>;
    readonly confirmStrategy?: (strategyId: string) => Promise<void>;
    readonly confirmAndExecute?: (strategyId: string) => Promise<void>;
    readonly operationalLog?: OperationalLog;
    readonly secretProvider?: () => readonly string[];
    readonly loggerInstance?: FastifyBaseLogger;
  } = {}
): Fixture {
  const database = new Database(':memory:');
  const baseRepository = new SqliteStrategyRepository(database);
  const repository = options.repository ?? baseRepository;
  const preflightInputs: PreflightInput[] = [];
  const confirmationInputs: string[] = [];
  let confirmationCount = 0;
  let executionCount = 0;
  const server = buildTestServer({
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
    confirmationService: {
      confirm: async (strategyId) => {
        confirmationCount += 1;
        confirmationInputs.push(strategyId);
        await options.confirmStrategy?.(strategyId);
      }
    },
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
    ...(options.loggerInstance === undefined
      ? { logger: false as const }
      : { loggerInstance: options.loggerInstance })
  });
  t.after(async () => {
    await server.close();
    database.close();
  });
  return {
    server,
    repository: baseRepository,
    preflightInputs,
    confirmationInputs,
    getConfirmationCount: () => confirmationCount,
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
      preflightFailure: null,
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

const DETAILED_BROWSER_DETAIL = createTradeOpsError({
  code: 'BALANCE_INSUFFICIENT',
  phase: 'preflight',
  subject: {
    type: 'account',
    exchangeId: 'bitget',
    symbol: SYMBOL,
    field: 'balance'
  },
  expected: '60000.00000000000000000001 USDT',
  actual: '<b>59999.99999999999999999999 USDT</b>',
  occurredAt: '2026-10-03T00:00:00.000Z'
}).detail;

const DETAILED_BROWSER_ERROR = {
  requestId: 'req-3',
  error: DETAILED_BROWSER_DETAIL
} as const;

function assertDetailedBrowserMessage(
  message: string,
  operation: string,
  status: number
): void {
  assert.match(message, new RegExp(`^${operation}失败`));
  assert.match(message, new RegExp(`HTTP ${status}`));
  assert.match(message, /BALANCE_INSUFFICIENT/);
  assert.match(message, new RegExp(DETAILED_BROWSER_DETAIL.message));
  assert.match(message, /阶段[：:]/);
  assert.match(message, /preflight/);
  assert.match(message, /对象[：:]/);
  assert.match(message, /account/);
  assert.match(message, /bitget/);
  assert.match(message, /期望[：:]/);
  assert.match(message, /60000\.00000000000000000001 USDT/);
  assert.match(message, /实际[：:]/);
  assert.match(message, /<b>59999\.99999999999999999999 USDT<\/b>/);
  assert.match(message, /请求 ID[：:]req-3/);
}

test('operator UI shows detailed structured preflight failures as plain text', async () => {
  const browser = await browserHarness();
  browser.setFetch(async (url) => {
    assert.equal(url, '/api/hedges/preflight');
    return browserResponse(422, DETAILED_BROWSER_ERROR);
  });

  await browser.element('preflight-form').emit('submit');

  assertDetailedBrowserMessage(
    browser.element('operator-message').textContent,
    '预检',
    422
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

  assertDetailedBrowserMessage(
    browser.element('operator-message').textContent,
    '任务加载',
    404
  );
  assert.equal(browser.element('risk-ack').checked, false);
  assert.equal(browser.element('confirm-button').disabled, true);
});

test('operator UI shows detailed structured status-refresh failures', async () => {
  const browser = await browserWithValidPreflight();
  browser.setFetch(async () => browserResponse(503, DETAILED_BROWSER_ERROR));

  await browser.element('refresh-button').emit('click');

  assertDetailedBrowserMessage(
    browser.element('operator-message').textContent,
    '状态刷新',
    503
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

  assertDetailedBrowserMessage(
    browser.element('operator-message').textContent,
    '确认',
    409
  );
  assert.equal(browser.element('confirm-button').disabled, true);
});

test('operator UI shows detailed structured exchange-list failures', async () => {
  const browser = await browserHarness(async (url) => {
    assert.equal(url, '/api/exchanges');
    return browserResponse(500, DETAILED_BROWSER_ERROR);
  });

  assertDetailedBrowserMessage(
    browser.element('operator-message').textContent,
    '交易所列表加载',
    500
  );
});

test('operator UI renders every trusted subject and safe diagnostic value kind', async (t) => {
  const cases = [
    createTradeOpsError({
      code: 'CONFIG_FIELD_INVALID', phase: 'request',
      subject: { type: 'configuration', field: 'HOST' },
      expected: ['127.0.0.1', '::1'], actual: null
    }),
    createTradeOpsError({
      code: 'REQUEST_FIELD_INVALID', phase: 'request',
      subject: { type: 'request', field: 'requestedBaseQuantity' },
      expected: 'positive decimal string', actual: 'string'
    }),
    createTradeOpsError({
      code: 'EXCHANGE_NOT_CONFIGURED', phase: 'preflight',
      subject: { type: 'exchange', exchangeId: 'synthetic-exchange', operation: 'preflight' },
      expected: 'configured exchange', actual: false
    }),
    createTradeOpsError({
      code: 'MARKET_INACTIVE', phase: 'confirmation',
      subject: {
        type: 'market', exchangeId: 'okx', symbol: SYMBOL, kind: 'swap',
        field: 'active'
      },
      expected: true, actual: false
    }),
    createTradeOpsError({
      code: 'BALANCE_INSUFFICIENT', phase: 'preflight',
      subject: { type: 'account', exchangeId: 'bitget', symbol: SYMBOL, field: 'balance' },
      expected: '1.00000000000000000001 BTC',
      actual: '0.99999999999999999999 BTC'
    }),
    createTradeOpsError({
      code: 'STRATEGY_STATE_MISMATCH', phase: 'confirmation',
      subject: { type: 'strategy', strategyId: 'strategy-synthetic', field: 'state' },
      expected: 'PENDING_CONFIRMATION', actual: 'EXECUTING'
    }),
    createTradeOpsError({
      code: 'STORAGE_OPERATION_FAILED', phase: 'storage',
      subject: {
        type: 'database', table: 'strategies', recordId: 'strategy-synthetic',
        operation: 'read strategy'
      },
      expected: 'successful read', actual: 'failure'
    })
  ] as const;

  for (const failure of cases) {
    await t.test(failure.detail.subject.type, async () => {
      const browser = await browserHarness();
      browser.setFetch(async () => browserResponse(500, {
        requestId: `request-${failure.detail.subject.type}`,
        error: failure.detail
      }));

      await browser.element('preflight-form').emit('submit');

      const message = browser.element('operator-message').textContent;
      assert.match(message, /阶段[：:]/);
      assert.match(message, /对象[：:]/);
      assert.match(message, /期望[：:]/);
      assert.match(message, /实际[：:]/);
      assert.match(message, new RegExp(failure.detail.subject.type));
      assert.match(message, new RegExp(failure.detail.code));
      assert.match(message, new RegExp(`request-${failure.detail.subject.type}`));
    });
  }
});

test('operator UI rejects legacy JSON errors without displaying untrusted fields', async () => {
  const browser = await browserHarness();
  browser.setFetch(async () => browserResponse(422, {
    code: 'LEGACY_REJECTED',
    message: 'legacy detailed failure'
  }));

  await browser.element('preflight-form').emit('submit');

  const message = browser.element('operator-message').textContent;
  assert.match(message, /^预检失败\nHTTP 422/);
  assert.match(message, /结构化.*错误|错误结构/);
  assert.doesNotMatch(message, /LEGACY_REJECTED|legacy detailed failure/);
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

    const message = browser.element('operator-message').textContent;
    assert.match(message, /^预检失败\n网络.*失败/);
    assert.doesNotMatch(message, /connection refused/);
  });

  await t.test('hostile thrown value', async () => {
    const browser = await browserHarness();
    let messageGetterCalls = 0;
    let toStringCalls = 0;
    const hostile = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(hostile, 'message', {
      get() {
        messageGetterCalls += 1;
        return 'HOSTILE-MESSAGE-SENTINEL';
      }
    });
    Object.defineProperty(hostile, 'toString', {
      value() {
        toStringCalls += 1;
        return 'HOSTILE-TOSTRING-SENTINEL';
      }
    });
    browser.setFetch(async () => {
      throw hostile;
    });

    await browser.element('preflight-form').emit('submit');

    const message = browser.element('operator-message').textContent;
    assert.match(message, /^预检失败\n网络.*失败/);
    assert.equal(messageGetterCalls, 0);
    assert.equal(toStringCalls, 0);
    assert.doesNotMatch(message, /HOSTILE-/);
  });
});

test('operator UI bounds detailed server errors and labels invalid success responses', async (t) => {
  await t.test('bounded detail', async () => {
    const browser = await browserHarness();
    browser.setFetch(async () => browserResponse(422, {
      ...DETAILED_BROWSER_ERROR,
      error: { ...DETAILED_BROWSER_ERROR.error, message: 'x'.repeat(2_100) }
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
  let confirmationCalls = 0;
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
  const server = buildTestServer({
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
    confirmationService: {
      confirm: async () => {
        confirmationCalls += 1;
      }
    },
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
        code: 'REQUEST_FORBIDDEN',
        phase: 'request'
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
  assert.equal(confirmationCalls, 0);
  assert.equal(coordinatorCalls, 0);
});

test('rejects unsafe browser origins before preflight, repository, or coordinator', async (t) => {
  const database = new Database(':memory:');
  const targetRepository = new SqliteStrategyRepository(database);
  const strategy = targetRepository.createPending(preflight());
  let repositoryCalls = 0;
  let preflightCalls = 0;
  let confirmationCalls = 0;
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
  const server = buildTestServer({
    registry: { ids: () => ['bitget', 'okx'] },
    preflightService: {
      run: async () => {
        preflightCalls += 1;
        return preflight();
      }
    },
    repository,
    confirmationService: {
      confirm: async () => {
        confirmationCalls += 1;
      }
    },
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
        code: 'REQUEST_FORBIDDEN',
        phase: 'request'
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
  assert.equal(confirmationCalls, 0);
  assert.equal(coordinatorCalls, 0);
});

test('requires Origin on every POST before any write-path dependency', async (t) => {
  const database = new Database(':memory:');
  const targetRepository = new SqliteStrategyRepository(database);
  const strategy = targetRepository.createPending(preflight());
  let repositoryCalls = 0;
  let preflightCalls = 0;
  let confirmationCalls = 0;
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
  const server = buildTestServer({
    registry: { ids: () => ['bitget', 'okx'] },
    preflightService: {
      run: async () => {
        preflightCalls += 1;
        return preflight();
      }
    },
    repository,
    confirmationService: {
      confirm: async () => {
        confirmationCalls += 1;
      }
    },
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
      code: 'REQUEST_FORBIDDEN',
      phase: 'request'
    });
  }
  await flushImmediate();
  assert.equal(preflightCalls, 0);
  assert.equal(repositoryCalls, 0);
  assert.equal(confirmationCalls, 0);
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
    code: 'REQUEST_FORBIDDEN',
    phase: 'request'
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
      code: 'REQUEST_FIELD_INVALID',
      phase: 'request'
    });
    assert.doesNotMatch(response.body, /LEAK-ME-NOT/);
  }
  assert.equal(preflightInputs.length, 0);
});

test('preflight distinguishes malformed or non-object bodies from field validation', async (t) => {
  const fixture = setup(t);
  const cases = [
    { name: 'missing body' },
    {
      name: 'null body',
      headers: { ...LOCAL_HEADERS, 'content-type': 'application/json' },
      payload: 'null'
    },
    { name: 'array body', payload: [] },
    {
      name: 'string body',
      headers: { ...LOCAL_HEADERS, 'content-type': 'application/json' },
      payload: '"body-string"'
    },
    {
      name: 'malformed JSON',
      headers: { ...LOCAL_HEADERS, 'content-type': 'application/json' },
      payload: '{"symbol":'
    }
  ] as const;

  for (const item of cases) {
    await t.test(item.name, async () => {
      const response = await fixture.server.inject({
        method: 'POST',
        url: '/api/hedges/preflight',
        headers: 'headers' in item ? item.headers : LOCAL_HEADERS,
        ...('payload' in item ? { payload: item.payload } : {})
      });

      assert.equal(response.statusCode, 400);
      const detail = assertPublicHttpError(response, {
        code: 'REQUEST_BODY_INVALID',
        phase: 'request'
      });
      assert.deepEqual(detail.subject, { type: 'request', field: 'body' });
      assert.doesNotMatch(response.body, /body-string|symbol/);
    });
  }
  assert.equal(fixture.preflightInputs.length, 0);
  assert.equal(fixture.getConfirmationCount(), 0);
  assert.equal(fixture.getExecutionCount(), 0);
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
        code: 'REQUEST_FIELD_INVALID',
        phase: 'request'
      });
      assert.doesNotMatch(response.body, /TYPE-SENTINEL/);
    }
  }
  assert.equal(preflightInputs.length, 0);
});

test('preflight preserves heterogeneous trusted business errors as 422', async (t) => {
  const failures = [
    createTradeOpsError({
      code: 'MARKET_INACTIVE',
      phase: 'preflight',
      subject: {
        type: 'market', exchangeId: 'okx', symbol: SYMBOL, kind: 'swap',
        field: 'active'
      },
      expected: true,
      actual: false,
      occurredAt: '2026-10-03T00:00:00.000Z'
    }),
    createTradeOpsError({
      code: 'ACCOUNT_MARGIN_MODE_MISMATCH',
      phase: 'preflight',
      subject: {
        type: 'account', exchangeId: 'okx', symbol: SYMBOL, field: 'marginMode'
      },
      expected: 'isolated',
      actual: 'cross',
      occurredAt: '2026-10-03T00:00:00.000Z'
    }),
    createTradeOpsError({
      code: 'QUANTITY_NOT_REPRESENTABLE',
      phase: 'preflight',
      subject: {
        type: 'market', exchangeId: 'okx', symbol: SYMBOL, kind: 'swap',
        field: 'amountPrecision'
      },
      expected: '0.00000000000000000001 BTC',
      actual: '0.000000000000000000001 BTC',
      occurredAt: '2026-10-03T00:00:00.000Z'
    })
  ] as const;

  for (const failure of failures) {
    await t.test(failure.detail.code, async (subtest) => {
      const fixture = setup(subtest, {
        runPreflight: async () => {
          throw failure;
        }
      });
      const response = await fixture.server.inject({
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
      assertPublicHttpError(response, {
        code: failure.detail.code,
        phase: 'preflight',
        detail: failure.detail
      });
      assert.equal(fixture.repository.listRecoverable().length, 0);
      assert.equal(fixture.getConfirmationCount(), 0);
      assert.equal(fixture.getExecutionCount(), 0);
    });
  }
});

test('preflight redacts configured secrets from a branded business detail', async (t) => {
  const configuredSecret = 'CONFIGURED-PREFLIGHT-SECRET';
  const input = {
    code: 'BALANCE_INSUFFICIENT',
    phase: 'preflight',
    subject: {
      type: 'account',
      exchangeId: 'bitget',
      symbol: SYMBOL,
      field: 'balance'
    },
    expected: 'available balance',
    actual: `insufficient-${configuredSecret}`,
    occurredAt: '2026-10-03T00:00:00.000Z'
  } as const;
  const failure = createTradeOpsError(input);
  const expected = createTradeOpsError(input, [configuredSecret]).detail;
  const fixture = setup(t, {
    runPreflight: async () => {
      throw failure;
    },
    secretProvider: () => [configuredSecret]
  });

  const response = await fixture.server.inject({
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
  assertPublicHttpError(response, {
    code: expected.code,
    phase: expected.phase,
    detail: expected
  });
  assert.doesNotMatch(response.body, new RegExp(configuredSecret));
  assert.equal(fixture.repository.listRecoverable().length, 0);
  assert.equal(fixture.getConfirmationCount(), 0);
  assert.equal(fixture.getExecutionCount(), 0);
});

test('an unknown preflight failure becomes a safe 500 without persistence', async (t) => {
  const sentinel = 'UNKNOWN-PREFLIGHT-SECRET';
  const fixture = setup(t, {
    runPreflight: async () => {
      throw Object.assign(new Error(`${sentinel} raw message`), {
        code: sentinel,
        cause: new Error(`${sentinel} cause`),
        response: { body: sentinel }
      });
    },
    secretProvider: () => [sentinel]
  });

  const response = await fixture.server.inject({
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

  assert.equal(response.statusCode, 500);
  assertPublicHttpError(response, {
    code: 'REQUEST_OPERATION_FAILED',
    phase: 'request'
  });
  assert.equal(fixture.repository.listRecoverable().length, 0);
  assert.doesNotMatch(response.body, new RegExp(sentinel));
  assert.doesNotMatch(response.body, /cause|stack|response/);
});

test('a failing secret provider keeps the business status with safe detail', async (t) => {
  const failure = createTradeOpsError({
    code: 'BALANCE_INSUFFICIENT',
    phase: 'preflight',
    subject: {
      type: 'account',
      exchangeId: 'bitget',
      symbol: SYMBOL,
      field: 'balance'
    },
    expected: 'available balance',
    actual: 'insufficient balance'
  });
  const { server } = setup(t, {
    runPreflight: async () => {
      throw failure;
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
  assert.deepEqual(Object.keys(body).sort(), ['error', 'requestId']);
  assert.equal(typeof body.requestId, 'string');
  assert.doesNotThrow(() => parseErrorDetail(body.error));
  assert.doesNotMatch(response.body, /secret provider/);
});

test('confirmation requires the exact true risk acknowledgement before queueing', async (t) => {
  const {
    server,
    repository,
    getConfirmationCount,
    getExecutionCount
  } = setup(t);
  const strategy = repository.createPending(preflight());
  const invalidPayloads = [
    { payload: undefined, code: 'REQUEST_BODY_INVALID' },
    { payload: {}, code: 'REQUEST_FIELD_INVALID' },
    { payload: { riskAcknowledged: false }, code: 'REQUEST_FIELD_INVALID' },
    {
      payload: { riskAcknowledged: true, extra: true },
      code: 'REQUEST_FIELD_INVALID'
    }
  ];

  for (const item of invalidPayloads) {
    const response = await server.inject({
      method: 'POST',
      url: `/api/hedges/${strategy.id}/confirm`,
      headers: LOCAL_HEADERS,
      ...(item.payload === undefined ? {} : { payload: item.payload })
    });
    assert.equal(response.statusCode, 400);
    assertPublicHttpError(response, {
      code: item.code,
      phase: 'request'
    });
  }
  await flushImmediate();
  assert.equal(getConfirmationCount(), 0);
  assert.equal(getExecutionCount(), 0);
  assert.equal(repository.getStrategy(strategy.id).state, 'PENDING_CONFIRMATION');
});

test('confirmation never coerces acknowledgement runtime types', async (t) => {
  const {
    server,
    repository,
    getConfirmationCount,
    getExecutionCount
  } = setup(t);
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
      code: 'REQUEST_FIELD_INVALID',
      phase: 'request'
    });
    assert.doesNotMatch(response.body, /TYPE-SENTINEL/);
  }
  await flushImmediate();
  assert.equal(getConfirmationCount(), 0);
  assert.equal(getExecutionCount(), 0);
  assert.equal(repository.getStrategy(strategy.id).state, 'PENDING_CONFIRMATION');
});

test('confirmation route delegates without reading the repository directly', async (t) => {
  const database = new Database(':memory:');
  const target = new SqliteStrategyRepository(database);
  const pending = target.createPending(preflight());
  const repository = new Proxy<StrategyRepository>(target, {
    get(targetRepository, property, receiver) {
      if (property === 'getStrategy') {
        return (): never => {
          throw new Error('ROUTE-DIRECT-READ-SENTINEL');
        };
      }
      const value = Reflect.get(targetRepository, property, receiver);
      return typeof value === 'function' ? value.bind(targetRepository) : value;
    }
  });
  t.after(() => database.close());
  const fixture = setup(t, { repository });

  const response = await fixture.server.inject({
    method: 'POST',
    url: `/api/hedges/${pending.id}/confirm`,
    headers: LOCAL_HEADERS,
    payload: { riskAcknowledged: true }
  });
  await flushImmediate();

  assert.equal(response.statusCode, 202);
  assert.deepEqual(response.json(), { accepted: true });
  assert.deepEqual(fixture.confirmationInputs, [pending.id]);
  assert.equal(fixture.getExecutionCount(), 1);
  assert.doesNotMatch(response.body, /ROUTE-DIRECT-READ-SENTINEL/);
});

test('confirmation waits for commit and lock release before responding and queueing', async (t) => {
  const events: string[] = [];
  let releaseConfirmation: (() => void) | undefined;
  const confirmationGate = new Promise<void>((resolve) => {
    releaseConfirmation = resolve;
  });
  const fixture = setup(t, {
    confirmStrategy: async () => {
      events.push('confirm-start');
      await confirmationGate;
      events.push('confirm-resolve');
    },
    confirmAndExecute: async () => {
      events.push('coordinator-start');
    }
  });
  const pending = fixture.repository.createPending(preflight());
  let httpResolved = false;
  const responsePromise = fixture.server.inject({
    method: 'POST',
    url: `/api/hedges/${pending.id}/confirm`,
    headers: LOCAL_HEADERS,
    payload: { riskAcknowledged: true }
  }).then((response) => {
    httpResolved = true;
    events.push('http-resolve');
    return response;
  });

  for (let attempt = 0; attempt < 20 && events.length === 0; attempt += 1) {
    await flushImmediate();
  }
  const observedBeforeRelease = {
    events: [...events],
    httpResolved,
    executionCount: fixture.getExecutionCount()
  };
  releaseConfirmation?.();
  const response = await responsePromise;
  await flushImmediate();

  assert.deepEqual(observedBeforeRelease, {
    events: ['confirm-start'],
    httpResolved: false,
    executionCount: 0
  });
  assert.equal(response.statusCode, 202);
  assert.deepEqual(events, [
    'confirm-start',
    'confirm-resolve',
    'http-resolve',
    'coordinator-start'
  ]);
});

test('competing confirmation is busy for every first-request outcome', async (t) => {
  const cases = [
    {
      name: 'first confirmation succeeds',
      firstStatus: 202,
      firstError: undefined,
      firstCode: undefined,
      executionCount: 1
    },
    {
      name: 'business recheck failure commits invalidation',
      firstStatus: 409,
      firstError: createTradeOpsError({
        code: 'MARKET_INACTIVE', phase: 'confirmation',
        subject: {
          type: 'market', exchangeId: 'okx', symbol: SYMBOL, kind: 'swap',
          field: 'active'
        },
        expected: true, actual: false
      }),
      firstCode: 'MARKET_INACTIVE',
      executionCount: 0
    },
    {
      name: 'external recheck read failure commits invalidation',
      firstStatus: 409,
      firstError: createTradeOpsError({
        code: 'PRICE_UNAVAILABLE', phase: 'confirmation',
        subject: {
          type: 'market', exchangeId: 'okx', symbol: SYMBOL, kind: 'swap',
          field: 'price'
        },
        expected: 'available reference price', actual: 'read-failed'
      }),
      firstCode: 'PRICE_UNAVAILABLE',
      executionCount: 0
    },
    {
      name: 'initial storage read fails before invalidation',
      firstStatus: 500,
      firstError: createTradeOpsError({
        code: 'STORAGE_OPERATION_FAILED', phase: 'storage',
        subject: {
          type: 'database', table: 'strategies', operation: 'read strategy'
        },
        expected: 'successful read strategy', actual: 'read-failed'
      }),
      firstCode: 'STORAGE_OPERATION_FAILED',
      executionCount: 0
    }
  ] as const;

  for (const item of cases) {
    await t.test(item.name, async (subtest) => {
      let invocationCount = 0;
      let releaseFirst: (() => void) | undefined;
      const firstGate = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      const fixture = setup(subtest, {
        confirmStrategy: async (strategyId) => {
          invocationCount += 1;
          if (invocationCount > 1) {
            throw createTradeOpsError({
              code: 'STRATEGY_OPERATION_BUSY',
              phase: 'confirmation',
              subject: { type: 'strategy', strategyId, field: 'operationLock' },
              expected: 'available',
              actual: 'busy'
            });
          }
          await firstGate;
          if (item.firstError !== undefined) {
            throw item.firstError;
          }
        }
      });
      const pending = fixture.repository.createPending(preflight());
      const request = {
        method: 'POST' as const,
        url: `/api/hedges/${pending.id}/confirm`,
        headers: LOCAL_HEADERS,
        payload: { riskAcknowledged: true }
      };
      const firstPromise = fixture.server.inject(request);
      for (
        let attempt = 0;
        attempt < 20 && invocationCount === 0;
        attempt += 1
      ) {
        await flushImmediate();
      }
      const firstStartedBeforeCompetition = invocationCount === 1;
      const secondPromise = fixture.server.inject(request);
      for (
        let attempt = 0;
        attempt < 20 && invocationCount < 2;
        attempt += 1
      ) {
        await flushImmediate();
      }
      releaseFirst?.();
      const [first, second] = await Promise.all([firstPromise, secondPromise]);
      await flushImmediate();

      assert.equal(firstStartedBeforeCompetition, true);
      assert.equal(first.statusCode, item.firstStatus);
      if (item.firstCode === undefined) {
        assert.deepEqual(first.json(), { accepted: true });
      } else {
        assertPublicHttpError(first, {
          code: item.firstCode,
          phase: item.firstError.detail.phase,
          detail: item.firstError.detail
        });
      }
      assert.equal(second.statusCode, 409);
      assertPublicHttpError(second, {
        code: 'STRATEGY_OPERATION_BUSY',
        phase: 'confirmation'
      });
      assert.equal(fixture.getConfirmationCount(), 2);
      assert.equal(fixture.getExecutionCount(), item.executionCount);
    });
  }
});

test('confirmation maps precise failures by context without queueing', async (t) => {
  const strategyId = 'strategy-confirmation-errors';
  const cases: ReadonlyArray<{
    readonly name: string;
    readonly status: number;
    readonly error: unknown;
    readonly code: string;
    readonly phase: ErrorDetail['phase'];
  }> = [
    {
      name: 'missing strategy',
      status: 404,
      error: createTradeOpsError({
        code: 'STRATEGY_NOT_FOUND', phase: 'confirmation',
        subject: { type: 'strategy', strategyId },
        expected: 'existing strategy', actual: 'missing'
      }),
      code: 'STRATEGY_NOT_FOUND', phase: 'confirmation'
    },
    ...(['EXECUTING', 'WAITING_HEDGE', 'HEDGED', 'HEDGE_INCOMPLETE', 'FAILED',
      'PREFLIGHT_INVALIDATED'] as const).map((state) => ({
      name: `state ${state}`,
      status: 409,
      error: createTradeOpsError({
        code: 'STRATEGY_STATE_MISMATCH', phase: 'confirmation',
        subject: { type: 'strategy', strategyId, field: 'state' },
        expected: 'PENDING_CONFIRMATION', actual: state
      }),
      code: 'STRATEGY_STATE_MISMATCH',
      phase: 'confirmation' as const
    })),
    {
      name: 'external preflight read invalidated after commit',
      status: 409,
      error: createTradeOpsError({
        code: 'PRICE_UNAVAILABLE', phase: 'confirmation',
        subject: {
          type: 'market', exchangeId: 'okx', symbol: SYMBOL, kind: 'swap',
          field: 'price'
        },
        expected: 'available reference price', actual: 'object-failure'
      }),
      code: 'PRICE_UNAVAILABLE', phase: 'confirmation'
    },
    {
      name: 'initial storage read failure',
      status: 500,
      error: createTradeOpsError({
        code: 'STORAGE_OPERATION_FAILED', phase: 'storage',
        subject: {
          type: 'database', table: 'strategies', recordId: strategyId,
          operation: 'read strategy'
        },
        expected: 'successful read strategy', actual: 'object-failure'
      }),
      code: 'STORAGE_OPERATION_FAILED', phase: 'storage'
    },
    {
      name: 'unknown confirmation failure',
      status: 500,
      error: Object.assign(new Error('CONFIRM-SECRET-SENTINEL'), {
        cause: new Error('CONFIRM-CAUSE-SENTINEL')
      }),
      code: 'REQUEST_OPERATION_FAILED', phase: 'request'
    }
  ];

  for (const item of cases) {
    await t.test(item.name, async (subtest) => {
      const fixture = setup(subtest, {
        confirmStrategy: async () => {
          throw item.error;
        }
      });
      const response = await fixture.server.inject({
        method: 'POST',
        url: `/api/hedges/${strategyId}/confirm`,
        headers: LOCAL_HEADERS,
        payload: { riskAcknowledged: true }
      });
      await flushImmediate();

      assert.equal(response.statusCode, item.status);
      assertPublicHttpError(response, {
        code: item.code,
        phase: item.phase
      });
      assert.equal(fixture.getConfirmationCount(), 1);
      assert.equal(fixture.getExecutionCount(), 0);
      assert.doesNotMatch(
        response.body,
        /CONFIRM-SECRET-SENTINEL|CONFIRM-CAUSE-SENTINEL|cause|stack/
      );
    });
  }
});

test('background coordinator rejection is caught and server close drains queued work', async (t) => {
  const capture = completionCapture();
  const loggedErrors: CapturedOperationalError[] = [];
  let releaseExecution: (() => void) | undefined;
  const executionGate = new Promise<void>((resolve) => {
    releaseExecution = resolve;
  });
  const fixture = setup(t, {
    loggerInstance: capture.logger,
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
  const completion = completionForStatus(capture.lines(), 202);
  assert.equal(completion.level, 30);
  assert.equal(completion.httpError, undefined);
  assert.equal(completion.httpRequest, undefined);
  assert.equal(completionLines(capture.lines()).length, 1);
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
  for (const order of body.orders as Array<Record<string, unknown>>) {
    assert.equal(Object.hasOwn(order, 'submissionDisposition'), false);
    assert.equal(Object.hasOwn(order, 'submissionFailureCode'), false);
  }
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

test('status returns the same invalidation detail after reopening SQLite', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'trade-ops-task-5-status-'));
  const databasePath = join(directory, 'strategies.sqlite');
  let database = new Database(databasePath);
  let repository = new SqliteStrategyRepository(database);
  const pending = repository.createPending(preflight());
  const invalidation = createTradeOpsError({
    code: 'MARKET_INACTIVE',
    phase: 'confirmation',
    subject: {
      type: 'market',
      exchangeId: 'okx',
      symbol: SYMBOL,
      kind: 'swap',
      field: 'active'
    },
    expected: true,
    actual: false,
    occurredAt: '2026-10-03T00:00:00.000Z'
  }).detail;
  repository.invalidatePreflight(pending, invalidation);
  database.close();

  database = new Database(databasePath);
  repository = new SqliteStrategyRepository(database);
  let confirmationCalls = 0;
  let executionCalls = 0;
  const server = buildTestServer({
    registry: { ids: () => ['bitget', 'okx'] },
    preflightService: {
      run: async () => {
        throw new Error('status route must not run preflight');
      }
    },
    repository,
    confirmationService: {
      confirm: async () => {
        confirmationCalls += 1;
      }
    },
    coordinator: {
      confirmAndExecute: async () => {
        executionCalls += 1;
      }
    },
    logger: false
  });
  t.after(async () => {
    await server.close();
    database.close();
    await rm(directory, { recursive: true, force: true });
  });

  const response = await server.inject({
    method: 'GET',
    url: `/api/hedges/${pending.id}`,
    headers: LOCAL_HEADERS
  });

  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.strategy.state, 'PREFLIGHT_INVALIDATED');
  assert.equal(body.strategy.failureCode, null);
  assert.deepEqual(body.strategy.preflightFailure, invalidation);
  assert.deepEqual(body.orders, []);
  assert.deepEqual(body.actualFills, {
    spotBuyBaseQuantity: '0',
    contractShortBaseQuantity: '0',
    unmatchedBaseQuantity: '0'
  });
  assert.equal(confirmationCalls, 0);
  assert.equal(executionCalls, 0);
});

test('trusted persisted projection and projection failures are side-effect free', async (t) => {
  await t.test('GET redacts configured secrets without rewriting SQLite', async (subtest) => {
    const configuredSecret = 'CONFIGURED-PERSISTED-SECRET';
    const input = {
      code: 'MARKET_INACTIVE',
      phase: 'confirmation',
      subject: {
        type: 'market',
        exchangeId: `exchange-${configuredSecret}`,
        symbol: SYMBOL,
        kind: 'swap',
        field: 'active'
      },
      expected: true,
      actual: false,
      occurredAt: '2026-10-03T00:00:00.000Z'
    } as const;
    const unsafePersistedDetail = createTradeOpsError(input).detail;
    const expectedPublicDetail = createTradeOpsError(
      input,
      [configuredSecret]
    ).detail;
    const fixture = setup(subtest, {
      secretProvider: () => [configuredSecret]
    });
    const pending = fixture.repository.createPending(preflight());
    fixture.repository.invalidatePreflight(pending, unsafePersistedDetail);
    const storedBefore = fixture.repository.getStrategy(pending.id);

    const response = await fixture.server.inject({
      method: 'GET',
      url: `/api/hedges/${pending.id}`,
      headers: LOCAL_HEADERS
    });

    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.strategy.state, 'PREFLIGHT_INVALIDATED');
    assert.deepEqual(
      parseErrorDetail(body.strategy.preflightFailure),
      expectedPublicDetail
    );
    assert.doesNotMatch(response.body, new RegExp(configuredSecret));
    assert.deepEqual(fixture.repository.getStrategy(pending.id), storedBefore);
    assert.deepEqual(storedBefore.preflightFailure, unsafePersistedDetail);
    assert.match(
      JSON.stringify(storedBefore.preflightFailure),
      new RegExp(configuredSecret)
    );
    assert.equal(fixture.getConfirmationCount(), 0);
    assert.equal(fixture.getExecutionCount(), 0);
  });

  await t.test('confirmation keeps committed invalidation when projection fails', async (subtest) => {
    const providerSentinel = 'PROVIDER-FAILURE-SENTINEL';
    const failure = createTradeOpsError({
      code: 'MARKET_INACTIVE',
      phase: 'confirmation',
      subject: {
        type: 'market',
        exchangeId: 'okx',
        symbol: SYMBOL,
        kind: 'swap',
        field: 'active'
      },
      expected: true,
      actual: false,
      occurredAt: '2026-10-03T00:00:00.000Z'
    });
    let confirmBehavior: (strategyId: string) => Promise<void> = async () => {
      throw new Error('confirmation behavior not initialized');
    };
    const fixture = setup(subtest, {
      confirmStrategy: async (strategyId) => confirmBehavior(strategyId),
      secretProvider: () => {
        throw new Error(providerSentinel);
      }
    });
    const pending = fixture.repository.createPending(preflight());
    confirmBehavior = async (strategyId) => {
      const current = fixture.repository.getStrategy(strategyId);
      fixture.repository.invalidatePreflight(current, failure.detail);
      throw failure;
    };

    const response = await fixture.server.inject({
      method: 'POST',
      url: `/api/hedges/${pending.id}/confirm`,
      headers: LOCAL_HEADERS,
      payload: { riskAcknowledged: true }
    });
    await flushImmediate();

    assert.equal(response.statusCode, 409);
    const body = response.json();
    assert.equal(typeof body.requestId, 'string');
    assert.deepEqual(Object.keys(body).sort(), ['error', 'requestId']);
    assert.doesNotThrow(() => parseErrorDetail(body.error));
    assert.match(String(response.headers['cache-control'] ?? ''), /no-store/);
    assert.match(
      String(response.headers['content-security-policy'] ?? ''),
      /default-src 'self'/
    );
    assert.doesNotMatch(response.body, new RegExp(providerSentinel));

    const stored = fixture.repository.getStrategy(pending.id);
    assert.equal(stored.state, 'PREFLIGHT_INVALIDATED');
    assert.deepEqual(stored.preflightFailure, failure.detail);
    assert.equal(stored.failureCode, null);
    assert.deepEqual(fixture.repository.listOrders(pending.id), []);
    assert.equal(fixture.getConfirmationCount(), 1);
    assert.equal(fixture.getExecutionCount(), 0);
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
  assertPublicHttpError(missing, {
    code: 'STRATEGY_NOT_FOUND',
    phase: 'request'
  });

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
    code: 'REQUEST_OPERATION_FAILED',
    phase: 'request'
  });
  assert.doesNotMatch(tampered.body, /LEAK-ME-NOT|unconfigured-token|apiKey/);
  assert.deepEqual(
    loggedErrors.filter((entry) => entry.event === 'unhandled_http_request_failure'),
    []
  );
});

test('unknown thrown values cannot impersonate repository or framework errors', async (t) => {
  const first = setup(t);
  const fakeMissing = Object.create(
    StrategyNotFoundError.prototype
  ) as StrategyNotFoundError;
  const spoofedRepository = new Proxy<StrategyRepository>(first.repository, {
    get(target, property, receiver) {
      if (property === 'getStrategy') {
        return (): never => {
          throw fakeMissing;
        };
      }
      return Reflect.get(target, property, receiver);
    }
  });
  const spoofedFixture = setup(t, { repository: spoofedRepository });
  const spoofedMissing = await spoofedFixture.server.inject({
    method: 'GET',
    url: '/api/hedges/spoofed-missing',
    headers: LOCAL_HEADERS
  });

  assert.equal(spoofedMissing.statusCode, 500);
  assertPublicHttpError(spoofedMissing, {
    code: 'REQUEST_OPERATION_FAILED',
    phase: 'request'
  });

  let codeReads = 0;
  let validationReads = 0;
  const hostileFrameworkShape = new Error('untrusted route failure');
  Object.defineProperties(hostileFrameworkShape, {
    code: {
      get(): string {
        codeReads += 1;
        return 'FST_ERR_CTP_INVALID_JSON_BODY';
      }
    },
    validation: {
      get(): readonly unknown[] {
        validationReads += 1;
        return [{ keyword: 'required' }];
      }
    }
  });
  const frameworkFixture = setup(t);
  frameworkFixture.server.get('/test/hostile-framework-shape', async () => {
    throw hostileFrameworkShape;
  });
  const hostileFramework = await frameworkFixture.server.inject({
    method: 'GET',
    url: '/test/hostile-framework-shape',
    headers: LOCAL_HEADERS
  });

  assert.equal(hostileFramework.statusCode, 500);
  assertPublicHttpError(hostileFramework, {
    code: 'REQUEST_OPERATION_FAILED',
    phase: 'request'
  });
  assert.equal(codeReads, 0);
  assert.equal(validationReads, 0);

  const { proxy: revoked, revoke } = Proxy.revocable({}, {});
  revoke();
  const revokedRepository = new Proxy<StrategyRepository>(first.repository, {
    get(target, property, receiver) {
      if (property === 'getStrategy') {
        return (): never => {
          throw revoked;
        };
      }
      return Reflect.get(target, property, receiver);
    }
  });
  const revokedFixture = setup(t, { repository: revokedRepository });
  const revokedResponse = await revokedFixture.server.inject({
    method: 'GET',
    url: '/api/hedges/revoked-throwable',
    headers: LOCAL_HEADERS
  });

  assert.equal(revokedResponse.statusCode, 500);
  assertPublicHttpError(revokedResponse, {
    code: 'REQUEST_OPERATION_FAILED',
    phase: 'request'
  });
});

test('parameter validation remains a field error when the request has no body', async (t) => {
  const fixture = setup(t);
  const response = await fixture.server.inject({
    method: 'GET',
    url: '/api/hedges/invalid.id',
    headers: LOCAL_HEADERS
  });

  assert.equal(response.statusCode, 400);
  const detail = assertPublicHttpError(response, {
    code: 'REQUEST_FIELD_INVALID',
    phase: 'request'
  });
  assert.deepEqual(detail.subject, { type: 'request', field: 'id' });
});

test('unmatched API routes and static resources use the typed route 404', async (t) => {
  const fixture = setup(t);
  const responses = await Promise.all([
    fixture.server.inject({
      method: 'GET',
      url: '/api/route-that-does-not-exist?kind=synthetic',
      headers: LOCAL_HEADERS
    }),
    fixture.server.inject({
      method: 'GET',
      url: '/missing-static-resource.js',
      headers: LOCAL_HEADERS
    })
  ]);

  for (const response of responses) {
    assert.equal(response.statusCode, 404);
    const detail = assertPublicHttpError(response, {
      code: 'REQUEST_ROUTE_NOT_FOUND',
      phase: 'request'
    });
    assert.deepEqual(detail.subject, { type: 'request', field: 'route' });
    assert.doesNotMatch(response.body, /synthetic|missing-static-resource/);
  }
  assert.equal(fixture.preflightInputs.length, 0);
  assert.equal(fixture.getConfirmationCount(), 0);
  assert.equal(fixture.getExecutionCount(), 0);
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
      warn(): void {},
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
    code: 'REQUEST_OPERATION_FAILED',
    phase: 'request'
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
  assert.equal(browser.element('risk-ack').checked, false);
  assert.equal(browser.element('confirm-button').disabled, true);
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

test('operator UI loads an EXECUTING strategy for observation without confirmation', async () => {
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
  assert.equal(browser.element('confirm-button').disabled, true);
  await browser.element('confirm-button').emit('click');
  assert.equal(
    browser.fetchCalls.filter(({ url }) => url.endsWith('/confirm')).length,
    0
  );
  assert.equal(browser.element('confirm-button').disabled, true);
});

test('operator UI leaves an EXECUTING recovery intent to the monitor', async () => {
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
    throw new Error(`unexpected single-intent URL: ${url}`);
  });

  await browser.element('resume-form').emit('submit');
  assert.equal(browser.element('strategy-state').textContent, 'EXECUTING');
  assert.equal(browser.element('risk-ack').checked, false);
  assert.equal(browser.element('confirm-button').disabled, true);

  browser.element('risk-ack').checked = true;
  await browser.element('risk-ack').emit('change');
  assert.equal(browser.element('confirm-button').disabled, true);
  await browser.element('confirm-button').emit('click');

  assert.equal(
    browser.fetchCalls.filter(({ url }) => url.endsWith('/confirm')).length,
    0
  );
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

test('operator UI renders invalidation detail as terminal plain text', async () => {
  const browser = await browserHarness();
  const strategyId = '123e4567-e89b-42d3-a456-426614174019';
  const failure = createTradeOpsError({
    code: 'MARKET_INACTIVE',
    phase: 'confirmation',
    subject: {
      type: 'market',
      exchangeId: 'okx',
      symbol: SYMBOL,
      kind: 'swap',
      field: 'active'
    },
    expected: true,
    actual: '<img src=x onerror=INVALIDATION-SENTINEL>',
    occurredAt: '2026-10-03T00:00:00.000Z'
  }).detail;
  const status = browserStatusResponse();
  Object.assign(status.strategy as Record<string, unknown>, {
    id: strategyId,
    state: 'PREFLIGHT_INVALIDATED',
    failureCode: null,
    preflightFailure: failure
  });
  status.orders = [];
  setBrowserActualFills(status, '0', '0', '0');
  browser.element('resume-strategy-id').value = strategyId;
  browser.setFetch(async (url) => {
    assert.equal(url, `/api/hedges/${strategyId}`);
    return browserResponse(200, status);
  });

  await browser.element('resume-form').emit('submit');
  browser.element('risk-ack').checked = true;
  await browser.element('risk-ack').emit('change');
  await browser.element('confirm-button').emit('click');

  assert.equal(
    browser.element('strategy-state').textContent,
    'PREFLIGHT_INVALIDATED'
  );
  const message = browser.element('operator-message').textContent;
  assert.match(message, /重新预检/);
  assert.match(message, new RegExp(failure.message));
  assert.match(message, /阶段[：:].*confirmation/);
  assert.match(message, /对象[：:].*market/);
  assert.match(message, /期望[：:].*true/);
  assert.match(message, /实际[：:].*INVALIDATION-SENTINEL/);
  assert.equal(browser.element('risk-ack').checked, false);
  assert.equal(browser.element('confirm-button').disabled, true);
  assert.equal(browser.element('refresh-button').disabled, false);
  assert.equal(
    browser.fetchCalls.filter(({ url }) => url.endsWith('/confirm')).length,
    0
  );
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
  assert.equal(browser.element('confirm-button').disabled, true);

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
      name: 'strategy omits preflight failure field',
      mutate(body) {
        delete (body.strategy as Record<string, unknown>).preflightFailure;
      }
    },
    {
      name: 'pending strategy carries a preflight failure',
      mutate(body) {
        (body.strategy as Record<string, unknown>).preflightFailure =
          DETAILED_BROWSER_DETAIL;
      }
    },
    {
      name: 'invalidated strategy omits its preflight failure',
      mutate(body) {
        Object.assign(body.strategy as Record<string, unknown>, {
          state: 'PREFLIGHT_INVALIDATED',
          preflightFailure: null
        });
        body.orders = [];
        setBrowserActualFills(body, '0', '0', '0');
      }
    },
    {
      name: 'invalidated strategy contains an order',
      mutate(body) {
        Object.assign(body.strategy as Record<string, unknown>, {
          state: 'PREFLIGHT_INVALIDATED',
          preflightFailure: DETAILED_BROWSER_DETAIL
        });
        oneOrder(body);
      }
    },
    {
      name: 'invalidated strategy carries malformed failure detail',
      mutate(body) {
        Object.assign(body.strategy as Record<string, unknown>, {
          state: 'PREFLIGHT_INVALIDATED',
          preflightFailure: {
            ...DETAILED_BROWSER_DETAIL,
            rawError: 'RAW-FAILURE-SENTINEL'
          }
        });
        body.orders = [];
        setBrowserActualFills(body, '0', '0', '0');
      }
    },
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
      | 'FAILED'
      | 'PREFLIGHT_INVALIDATED';
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
      actionable: false
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
      actionable: false
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
      actionable: false
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
      actionable: false
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
      actionable: false
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
      actionable: false
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
    },
    {
      name: 'invalidated preflight is terminal without orders',
      mode: 'CONCURRENT',
      state: 'PREFLIGHT_INVALIDATED',
      roles: [],
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
          : null,
        preflightFailure: item.state === 'PREFLIGHT_INVALIDATED'
          ? createTradeOpsError({
              code: 'MARKET_INACTIVE',
              phase: 'confirmation',
              subject: {
                type: 'market',
                exchangeId: 'okx',
                symbol: SYMBOL,
                kind: 'swap',
                field: 'active'
              },
              expected: true,
              actual: false,
              occurredAt: '2026-10-03T00:00:00.000Z'
            }).detail
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
  assert.equal(browser.element('confirm-button').disabled, true);

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

test('one status-aware completion log is emitted for success redirect and failures', async (t) => {
  const capture = completionCapture();
  const { server } = setup(t, { loggerInstance: capture.logger });
  server.get('/test/completion-200', async () => ({ ok: true }));
  server.get('/test/completion-302', async (_request, reply) => reply.redirect('/test/completion-200'));
  server.post('/test/completion-418', async (_request, reply) => reply.status(418).send({ responseSecret: 'must-not-be-logged' }));
  server.post('/test/completion-503', async (_request, reply) => reply.status(503).send({ responseSecret: 'must-not-be-logged' }));
  const url418 = '/test/completion-418?repeat=one&repeat=two&encoded=a%2Fb';
  const responses = await Promise.all([
    server.inject({ method: 'GET', url: '/test/completion-200', headers: { host: 'localhost:80' } }),
    server.inject({ method: 'GET', url: '/test/completion-302', headers: { host: 'localhost:80' } }),
    server.inject({
      method: 'POST',
      url: url418,
      headers: {
        ...LOCAL_HEADERS,
        authorization: 'AUTHORIZATION-HEADER-SENTINEL',
        cookie: 'COOKIE-HEADER-SENTINEL=1',
        'x-forwarded-host': 'FORWARDED-HOST-HEADER-SENTINEL'
      },
      payload: { passwordHint: 'ordinary', nested: ['value'] }
    }),
    server.inject({ method: 'POST', url: '/test/completion-503', headers: { ...LOCAL_HEADERS, 'content-type': 'application/json' }, payload: 'null' })
  ]);
  assert.deepEqual(responses.map((response) => response.statusCode), [200, 302, 418, 503]);
  const completions = completionLines(capture.lines());
  assert.equal(completions.length, 4);
  assert.equal(new Set(completions.map((line) => line.reqId)).size, 4);
  for (const status of [200, 302]) {
    const line = completionForStatus(completions, status);
    assert.equal(line.level, 30);
    assert.equal(line.httpError, undefined);
    assert.equal(line.httpRequest, undefined);
  }
  for (const status of [418, 503]) {
    const line = completionForStatus(completions, status);
    assert.equal(line.level, status === 418 ? 40 : 50);
    assert.deepEqual(line.httpError, { code: 'HTTP_ERROR', message: `HTTP request failed with status ${status}` });
    assert.deepEqual(Object.keys(line.httpRequest as object).sort(), ['body', 'method', 'originalByteLength', 'truncated', 'url']);
  }
  assert.equal((completionForStatus(completions, 418).httpRequest as Record<string, unknown>).url, url418);
  const serializedCompletions = JSON.stringify(completions);
  assert.doesNotMatch(
    serializedCompletions,
    /AUTHORIZATION-HEADER-SENTINEL|COOKIE-HEADER-SENTINEL|FORWARDED-HOST-HEADER-SENTINEL|must-not-be-logged/
  );
  for (const status of [418, 503]) {
    assert.equal(
      Object.hasOwn(completionForStatus(completions, status).httpRequest as object, 'headers'),
      false
    );
  }
});

test('completion captures valid body invalid JSON and stable known errors', async (t) => {
  const capture = completionCapture();
  const { server } = setup(t, {
    loggerInstance: capture.logger,
    runPreflight: async () => {
      throw Object.assign(new Error('authentication failed'), {
        name: 'AuthenticationError',
        code: '40101',
        extra: 'ERROR-EXTRA-SENTINEL',
        validation: [{ message: 'VALIDATION-ARRAY-SENTINEL' }]
      });
    }
  });
  const validBody = { spotExchangeId: 'bitget', contractExchangeId: 'okx', symbol: SYMBOL, requestedBaseQuantity: '1', mode: 'SPOT_FIRST' };
  const valid = await server.inject({ method: 'POST', url: '/api/hedges/preflight?dryRun=false', headers: LOCAL_HEADERS, payload: validBody });
  const invalidText = '{"symbol":"RAW-INVALID"';
  const invalid = await server.inject({ method: 'POST', url: '/api/hedges/preflight?source=raw', headers: { ...LOCAL_HEADERS, 'content-type': 'application/json' }, payload: invalidText });
  assert.equal(valid.statusCode, 500);
  assert.equal(invalid.statusCode, 400);
  const completions = completionLines(capture.lines());
  const preflightLine = completionForStatus(completions, 500);
  assert.notEqual(preflightLine.httpError, undefined);
  const loggedError = preflightLine.httpError as Record<string, unknown>;
  assert.deepEqual(Object.keys(loggedError).sort(), ['code', 'error', 'message']);
  assert.equal(loggedError.code, 'REQUEST_OPERATION_FAILED');
  const loggedDetail = parseErrorDetail(loggedError.error);
  assert.equal(loggedError.message, loggedDetail.message);
  assert.equal(loggedDetail.code, 'REQUEST_OPERATION_FAILED');
  assert.equal(loggedDetail.phase, 'request');
  assert.deepEqual((preflightLine.httpRequest as Record<string, unknown>).body, validBody);
  assert.equal((preflightLine.httpRequest as Record<string, unknown>).url, '/api/hedges/preflight?dryRun=false');
  const invalidLine = completionForStatus(completions, 400);
  assert.deepEqual(invalidLine.httpError, {
    code: 'REQUEST_BODY_INVALID',
    message: '请求正文结构检查失败'
  });
  assert.equal((invalidLine.httpRequest as Record<string, unknown>).body, invalidText);
  assert.doesNotMatch(
    JSON.stringify(completions),
    /AuthenticationError|authentication failed|40101|stack|ERROR-EXTRA-SENTINEL|VALIDATION-ARRAY-SENTINEL/
  );
});

test('completion redacts configured exact overlapping secrets across URL body and error', async (t) => {
  const capture = completionCapture();
  const { server } = setup(t, {
    loggerInstance: capture.logger, secretProvider: () => ['abc', '', 'abc123', 'abc']
  });
  server.post('/test/secret-abc123', async () => {
    throw Object.assign(new Error('token abc123 and abc'), { code: 'abc123' });
  });
  const response = await server.inject({
    method: 'POST', url: '/test/secret-abc123?token=abc123&ordinary=passwordHint', headers: LOCAL_HEADERS,
    payload: { abc123key: 'abc and abc123' }
  });
  assert.equal(response.statusCode, 500);
  const serialized = JSON.stringify(completionForStatus(capture.lines(), 500));
  assert.doesNotMatch(serialized, /abc123|(?<![A-Za-z])abc(?![A-Za-z])/);
  assert.match(serialized, /\[Redacted\]/);
  assert.match(serialized, /passwordHint/);
});

test('completion body metadata observes 8192 8193 and UTF-8 boundaries after redaction', async (t) => {
  const capture = completionCapture();
  const { server } = setup(t, { loggerInstance: capture.logger, secretProvider: () => ['S'.repeat(9000)] });
  server.post('/test/body-limit', async (_request, reply) => reply.status(418).send({ failed: true }));
  for (const value of ['x'.repeat(8180), 'x'.repeat(8181), `${'x'.repeat(8179)}界`, 'S'.repeat(9000)]) {
    const response = await server.inject({ method: 'POST', url: '/test/body-limit', headers: LOCAL_HEADERS, payload: { value } });
    assert.equal(response.statusCode, 418);
  }
  const requests = completionLines(capture.lines()).filter((line) => (line.res as { statusCode: number }).statusCode === 418).map((line) => line.httpRequest as Record<string, unknown>);
  assert.equal(requests.length, 4);
  assert.deepEqual({ truncated: requests[0]?.truncated, bytes: requests[0]?.originalByteLength }, { truncated: false, bytes: 8192 });
  assert.deepEqual({ truncated: requests[1]?.truncated, bytes: requests[1]?.originalByteLength }, { truncated: true, bytes: 8193 });
  assert.equal(typeof requests[2]?.body, 'string');
  assert.equal(Buffer.byteLength(requests[2]?.body as string, 'utf8') <= 8192, true);
  assert.equal((requests[2]?.body as string).includes('\uFFFD'), false);
  assert.deepEqual(requests[3]?.body, { value: '[Redacted]' });
  assert.equal(requests[3]?.truncated, false);
  assert.equal(requests[3]?.originalByteLength, Buffer.byteLength('{"value":"[Redacted]"}', 'utf8'));
});

test('completion request state remains isolated across concurrent failures', async (t) => {
  const capture = completionCapture();
  const { server } = setup(t, { loggerInstance: capture.logger, secretProvider: () => ['secret-one', 'secret-two'] });
  let releaseOne: (() => void) | undefined;
  let releaseTwo: (() => void) | undefined;
  const gateOne = new Promise<void>((resolve) => { releaseOne = resolve; });
  const gateTwo = new Promise<void>((resolve) => { releaseTwo = resolve; });
  server.post('/test/concurrent-one', async (_request, reply) => { await gateOne; return reply.status(418).send(); });
  server.post('/test/concurrent-two', async (_request, reply) => { await gateTwo; return reply.status(503).send(); });
  const first = server.inject({ method: 'POST', url: '/test/concurrent-one?id=one', headers: LOCAL_HEADERS, payload: { marker: 'body-one-secret-one' } });
  const second = server.inject({ method: 'POST', url: '/test/concurrent-two?id=two', headers: LOCAL_HEADERS, payload: { marker: 'body-two-secret-two' } });
  releaseTwo?.(); await second; releaseOne?.(); await first;
  const one = completionForStatus(capture.lines(), 418);
  const two = completionForStatus(capture.lines(), 503);
  assert.match(JSON.stringify(one), /one/);
  assert.doesNotMatch(JSON.stringify(one), /two|secret-one/);
  assert.match(JSON.stringify(two), /two/);
  assert.doesNotMatch(JSON.stringify(two), /one|secret-two/);
});

test('completion safely degrades when secret provider fails and failed preflight does not persist', async (t) => {
  const capture = completionCapture();
  let preflightRuns = 0;
  const { server, repository } = setup(t, {
    loggerInstance: capture.logger,
    secretProvider: () => { throw new Error('provider-secret'); },
    runPreflight: async () => { preflightRuns += 1; throw new Error('payload-secret'); }
  });
  const before = repository.listRecoverable().length;
  const response = await server.inject({
    method: 'POST', url: '/api/hedges/preflight?token=url-secret', headers: LOCAL_HEADERS,
    payload: { spotExchangeId: 'bitget', contractExchangeId: 'okx', symbol: SYMBOL, requestedBaseQuantity: '1', mode: 'SPOT_FIRST' }
  });
  assert.equal(response.statusCode, 500);
  assert.equal(preflightRuns, 1);
  assert.equal(repository.listRecoverable().length, before);
  const line = completionForStatus(capture.lines(), 500);
  assert.deepEqual(line.httpError, {
    code: 'REQUEST_OPERATION_FAILED',
    message: '请求处理操作检查失败'
  });
  assert.deepEqual(line.httpRequest, { method: '[Unavailable]', url: '[Unavailable]', body: '[Unavailable]', truncated: false, originalByteLength: Buffer.byteLength('[Unavailable]', 'utf8') });
  assert.doesNotMatch(JSON.stringify(line), /provider-secret|payload-secret|url-secret/);
});

test('forbidden completion excludes hostile headers and records stable request data', async (t) => {
  const capture = completionCapture();
  const { server } = setup(t, { loggerInstance: capture.logger });
  const response = await server.inject({
    method: 'POST',
    url: '/api/hedges/preflight?visible=query-value',
    headers: {
      host: 'HOST-HEADER-SENTINEL.invalid',
      origin: 'https://ORIGIN-HEADER-SENTINEL.invalid',
      authorization: 'AUTH-HEADER-SENTINEL',
      cookie: 'COOKIE-HEADER-SENTINEL=1'
    },
    payload: { visible: 'body-value' }
  });
  assert.equal(response.statusCode, 403);
  const line = completionForStatus(capture.lines(), 403);
  assert.equal(line.level, 40);
  assert.deepEqual(line.httpError, {
    code: 'REQUEST_FORBIDDEN',
    message: '请求来源安全检查失败'
  });
  const snapshot = line.httpRequest as Record<string, unknown>;
  assert.equal(snapshot.method, 'POST');
  assert.equal(snapshot.url, '/api/hedges/preflight?visible=query-value');
  assert.equal(snapshot.body, null);
  assert.equal(Object.hasOwn(snapshot, 'headers'), false);
  assert.doesNotMatch(
    JSON.stringify(line),
    /HOST-HEADER|ORIGIN-HEADER|AUTH-HEADER|COOKIE-HEADER|body-value/
  );
});


test('HTTP safety boundary rejects invalid Host and unsafe Origin before invalid JSON parsing', async (t) => {
  const database = new Database(':memory:');
  const targetRepository = new SqliteStrategyRepository(database);
  let repositoryCalls = 0;
  const repository = new Proxy<StrategyRepository>(targetRepository, {
    get(target, property) {
      const value = Reflect.get(target, property);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        repositoryCalls += 1;
        return Reflect.apply(value, target, args);
      };
    }
  });
  t.after(() => database.close());
  const capture = completionCapture();
  const fixture = setup(t, { repository, loggerInstance: capture.logger });
  const malformedJson = '{"symbol":"ATTACKER-BODY-SENTINEL"';
  const requests = [
    {
      label: 'invalid Host',
      headers: {
        host: 'INVALID-HOST-SENTINEL.invalid',
        origin: 'https://UNSAFE-ORIGIN-SENTINEL.invalid',
        'content-type': 'application/json'
      }
    },
    {
      label: 'unsafe Origin',
      headers: {
        host: 'localhost:80',
        origin: 'https://UNSAFE-ORIGIN-SENTINEL.invalid',
        'content-type': 'application/json'
      }
    },
    {
      label: 'missing Origin',
      headers: {
        host: 'localhost:80',
        'content-type': 'application/json'
      }
    }
  ] as const;

  for (const request of requests) {
    const response = await fixture.server.inject({
      method: 'POST',
      url: `/api/hedges/preflight?case=${encodeURIComponent(request.label)}`,
      headers: request.headers,
      payload: malformedJson
    });
    assert.equal(response.statusCode, 403, request.label);
    assertPublicHttpError(response, {
      code: 'REQUEST_FORBIDDEN',
      phase: 'request'
    });
  }

  assert.equal(fixture.preflightInputs.length, 0);
  assert.equal(repositoryCalls, 0);
  assert.equal(fixture.getExecutionCount(), 0);
  const completions = completionLines(capture.lines());
  assert.equal(completions.length, requests.length);
  for (const completion of completions) {
    assert.equal(completion.level, 40);
    assert.deepEqual(completion.httpError, {
      code: 'REQUEST_FORBIDDEN',
      message: '请求来源安全检查失败'
    });
    const snapshot = completion.httpRequest as Record<string, unknown>;
    assert.equal(snapshot.method, 'POST');
    assert.equal(
      snapshot.body === null,
      true
    );
  }
  assert.doesNotMatch(
    JSON.stringify(completions),
    /ATTACKER-BODY-SENTINEL|INVALID-HOST-SENTINEL|UNSAFE-ORIGIN-SENTINEL/
  );
});

test('HTTP safety boundary rejects invalid Host before Fastify body limit', async (t) => {
  const database = new Database(':memory:');
  const targetRepository = new SqliteStrategyRepository(database);
  let repositoryCalls = 0;
  const repository = new Proxy<StrategyRepository>(targetRepository, {
    get(target, property) {
      const value = Reflect.get(target, property);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        repositoryCalls += 1;
        return Reflect.apply(value, target, args);
      };
    }
  });
  t.after(() => database.close());
  const capture = completionCapture();
  const fixture = setup(t, { repository, loggerInstance: capture.logger });
  const oversizedPayload = JSON.stringify({
    attackerData: 'x'.repeat(1_048_576)
  });

  const response = await fixture.server.inject({
    method: 'POST',
    url: '/api/hedges/preflight?case=oversized',
    headers: {
      host: 'INVALID-HOST-LIMIT-SENTINEL.invalid',
      origin: 'https://UNSAFE-ORIGIN-LIMIT-SENTINEL.invalid',
      'content-type': 'application/json'
    },
    payload: oversizedPayload
  });

  assert.equal(response.statusCode, 403);
  assertPublicHttpError(response, {
    code: 'REQUEST_FORBIDDEN',
    phase: 'request'
  });
  assert.equal(fixture.preflightInputs.length, 0);
  assert.equal(repositoryCalls, 0);
  assert.equal(fixture.getExecutionCount(), 0);
  const completion = completionForStatus(capture.lines(), 403);
  assert.equal(completion.level, 40);
  assert.deepEqual(completion.httpError, {
    code: 'REQUEST_FORBIDDEN',
    message: '请求来源安全检查失败'
  });
  const snapshot = completion.httpRequest as Record<string, unknown>;
  assert.equal(snapshot.method, 'POST');
  assert.equal(
    snapshot.body === null,
    true
  );
  assert.doesNotMatch(
    JSON.stringify(completion),
    /INVALID-HOST-LIMIT-SENTINEL|UNSAFE-ORIGIN-LIMIT-SENTINEL/
  );
});


test('raw request capture has an independent 1 MiB limit below a route body limit', async (t) => {
  const capture = completionCapture();
  const { server } = setup(t, { loggerInstance: capture.logger });
  let handlerCalls = 0;
  server.post(
    '/test/raw-capture-limit',
    { bodyLimit: 2_097_152 },
    async () => {
      handlerCalls += 1;
      return { unexpected: true };
    }
  );
  const url = '/test/raw-capture-limit?source=malformed';
  const payloadSentinel = 'RAW-CAPTURE-LIMIT-PAYLOAD-SENTINEL';
  const malformedJson = `{"sentinel":"${payloadSentinel}","padding":"${'x'.repeat(1_100_000)}`;
  assert.equal(Buffer.byteLength(malformedJson, 'utf8') > 1_048_576, true);
  assert.equal(Buffer.byteLength(malformedJson, 'utf8') < 2_097_152, true);

  const response = await server.inject({
    method: 'POST',
    url,
    headers: {
      ...LOCAL_HEADERS,
      'content-type': 'application/json'
    },
    payload: malformedJson
  });

  assert.equal(response.statusCode, 400);
  assertPublicHttpError(response, {
    code: 'REQUEST_BODY_INVALID',
    phase: 'request'
  });
  assert.equal(handlerCalls, 0);
  const completions = completionLines(capture.lines());
  assert.equal(completions.length, 1);
  const completion = completionForStatus(completions, 400);
  assert.equal(completion.level, 40);
  assert.deepEqual(completion.httpError, {
    code: 'REQUEST_BODY_INVALID',
    message: '请求正文结构检查失败'
  });
  const snapshot = completion.httpRequest as Record<string, unknown>;
  assert.equal(snapshot.method, 'POST');
  assert.equal(snapshot.url, url);
  assert.equal(snapshot.body, '[Unavailable]');
  assert.equal(snapshot.truncated, false);
  assert.equal(
    snapshot.originalByteLength,
    Buffer.byteLength('[Unavailable]', 'utf8')
  );
  assert.doesNotMatch(JSON.stringify(completion), new RegExp(payloadSentinel));
});


test('body observation preserves parsed JSON values and no-body behavior', async (t) => {
  const capture = completionCapture();
  const { server } = setup(t, { loggerInstance: capture.logger });
  const seen: unknown[] = [];
  server.post('/test/parser-values', async (request, reply) => {
    seen.push(request.body);
    return reply.status(418).send({ failed: true });
  });
  const cases: Array<{ payload?: string; expected: unknown }> = [
    { payload: '{"object":true}', expected: { object: true } },
    { payload: '["array",2]', expected: ['array', 2] },
    { payload: '"string"', expected: 'string' },
    { payload: '42', expected: 42 },
    { payload: 'true', expected: true },
    { payload: 'null', expected: null },
    { expected: undefined }
  ];
  for (const entry of cases) {
    const response = await server.inject({
      method: 'POST',
      url: '/test/parser-values',
      headers: entry.payload === undefined
        ? LOCAL_HEADERS
        : { ...LOCAL_HEADERS, 'content-type': 'application/json' },
      ...(entry.payload === undefined ? {} : { payload: entry.payload })
    });
    assert.equal(response.statusCode, 418);
  }
  assert.deepEqual(seen, cases.map(({ expected }) => expected));
  const completions = completionLines(capture.lines());
  assert.equal(completions.length, cases.length);
  assert.deepEqual(
    completions.map((line) => (line.httpRequest as Record<string, unknown>).body),
    [{ object: true }, ['array', 2], 'string', 42, true, null, null]
  );
});

test('large valid JSON uses parsed body even after raw capture budget is exceeded', async (t) => {
  const capture = completionCapture();
  const { server } = setup(t, { loggerInstance: capture.logger });
  let parsedBody: unknown;
  server.post('/test/large-parsed', { bodyLimit: 2_097_152 }, async (request, reply) => {
    parsedBody = request.body;
    return reply.status(418).send({ failed: true });
  });
  const sentinel = 'PARSED-LARGE-BODY-SENTINEL';
  const payload = JSON.stringify({ sentinel, padding: 'x'.repeat(1_100_000) });
  const response = await server.inject({
    method: 'POST', url: '/test/large-parsed?kind=valid',
    headers: { ...LOCAL_HEADERS, 'content-type': 'application/json' }, payload
  });
  assert.equal(response.statusCode, 418);
  assert.equal((parsedBody as { sentinel: string }).sentinel, sentinel);
  const snapshot = completionForStatus(capture.lines(), 418).httpRequest as Record<string, unknown>;
  assert.equal(snapshot.body === '[Unavailable]', false);
  assert.equal(snapshot.truncated, true);
  assert.equal(snapshot.originalByteLength, Buffer.byteLength(payload, 'utf8'));
  assert.equal(typeof snapshot.body, 'string');
  assert.match(snapshot.body as string, /PARSED-LARGE-BODY-SENTINEL/);
});

test('known and fallback HTTP failures emit stable completion summaries', async (t) => {
  const capture = completionCapture();
  const loggedErrors: CapturedOperationalError[] = [];
  const fixture = setup(t, {
    loggerInstance: capture.logger,
    operationalLog: captureOperationalErrors(loggedErrors)
  });
  fixture.server.get('/test/internal-completion', async () => {
    throw Object.assign(new Error('internal failure'), { privateValue: 'ERROR-PRIVATE-SENTINEL' });
  });
  const schemaBody = { spotExchangeId: 'bitget', contractExchangeId: 'okx', symbol: SYMBOL, requestedBaseQuantity: '1', mode: 'INVALID_MODE' };
  const schema = await fixture.server.inject({ method: 'POST', url: '/api/hedges/preflight?kind=schema', headers: LOCAL_HEADERS, payload: schemaBody });
  const business = await fixture.server.inject({ method: 'GET', url: '/api/hedges/missing-business', headers: { host: 'localhost:80' } });
  const framework = await fixture.server.inject({ method: 'GET', url: '/missing-framework?kind=404', headers: { host: 'localhost:80' } });
  const internal = await fixture.server.inject({ method: 'GET', url: '/test/internal-completion?kind=500', headers: { host: 'localhost:80' } });
  assert.deepEqual([schema.statusCode, business.statusCode, framework.statusCode, internal.statusCode], [400, 404, 404, 500]);
  const lines = completionLines(capture.lines());
  const byUrl = (url: string): Record<string, unknown> => {
    const matches = lines.filter((line) => (line.httpRequest as { url?: string } | undefined)?.url === url);
    assert.equal(matches.length, 1);
    return matches[0] as Record<string, unknown>;
  };
  const schemaLine = byUrl('/api/hedges/preflight?kind=schema');
  assert.deepEqual((schemaLine.httpRequest as Record<string, unknown>).body, schemaBody);
  assert.deepEqual(schemaLine.httpError, {
    code: 'REQUEST_FIELD_INVALID',
    message: '请求字段有效性检查失败'
  });
  const businessError = byUrl('/api/hedges/missing-business')
    .httpError as Record<string, unknown>;
  assert.equal(businessError.code, 'STRATEGY_NOT_FOUND');
  assert.equal(businessError.message, '策略存在性检查失败');
  assert.equal(parseErrorDetail(businessError.error).code, 'STRATEGY_NOT_FOUND');
  assert.deepEqual(byUrl('/missing-framework?kind=404').httpError, {
    code: 'REQUEST_ROUTE_NOT_FOUND',
    message: '请求路由存在性检查失败'
  });
  const internalLine = byUrl('/test/internal-completion?kind=500');
  assert.equal(internalLine.level, 50);
  assert.equal(
    (internalLine.httpError as { code: string }).code,
    'REQUEST_OPERATION_FAILED'
  );
  assert.equal(Object.hasOwn(schemaLine.httpError as object, 'validation'), false);
  assert.equal(
    Object.hasOwn((schemaLine.httpError as { error?: object }).error ?? {}, 'validation'),
    false
  );
  assert.doesNotMatch(JSON.stringify(lines), /ERROR-PRIVATE-SENTINEL/);
  assert.equal(loggedErrors.some(({ event }) => event === 'unhandled_http_request_failure'), false);
});

test('completion redacts every reachable URL body raw-body and error string surface', async (t) => {
  const capture = completionCapture();
  const secrets = ['PATHSECRET', 'QUERYSECRET', 'KEYSECRET', 'VALUESECRET', 'RAWSECRET', 'ERRORSECRET', 'CODESECRET'];
  const { server } = setup(t, { loggerInstance: capture.logger, secretProvider: () => secrets });
  server.post('/test/redaction/:path', async () => {
    const error = Object.assign(new Error('message ERRORSECRET'), { code: 'CODESECRET' });
    error.stack = 'Error: ERRORSECRET stack';
    throw error;
  });
  const structured = await server.inject({
    method: 'POST',
    url: '/test/redaction/PATHSECRET?QUERYSECRET=VALUESECRET',
    headers: LOCAL_HEADERS,
    payload: { KEYSECRET: { nested: 'VALUESECRET', values: ['PATHSECRET'] } }
  });
  const raw = await server.inject({
    method: 'POST', url: '/api/hedges/preflight?raw=RAWSECRET',
    headers: { ...LOCAL_HEADERS, 'content-type': 'application/json' },
    payload: '{"raw":"RAWSECRET"'
  });
  assert.deepEqual([structured.statusCode, raw.statusCode], [500, 400]);
  const serialized = JSON.stringify(completionLines(capture.lines()));
  for (const secret of secrets) assert.doesNotMatch(serialized, new RegExp(secret));
  assert.match(serialized, /\[Redacted\]/);
});

test('concurrent preflight completions correlate response requestId with isolated error URL and body', async (t) => {
  const capture = completionCapture();
  let releaseOne: (() => void) | undefined;
  let releaseTwo: (() => void) | undefined;
  const gateOne = new Promise<void>((resolve) => { releaseOne = resolve; });
  const gateTwo = new Promise<void>((resolve) => { releaseTwo = resolve; });
  const fixture = setup(t, {
    loggerInstance: capture.logger,
    runPreflight: async (input) => {
      if (input.requestedBaseQuantity === '1') {
        await gateOne;
        throw new Error('ERROR-ONE');
      }
      await gateTwo;
      throw new Error('ERROR-TWO');
    }
  });
  const payloadFor = (quantity: string) => ({ spotExchangeId: 'bitget', contractExchangeId: 'okx', symbol: SYMBOL, requestedBaseQuantity: quantity, mode: 'SPOT_FIRST' });
  const firstPromise = fixture.server.inject({ method: 'POST', url: '/api/hedges/preflight?case=one', headers: LOCAL_HEADERS, payload: payloadFor('1') });
  const secondPromise = fixture.server.inject({ method: 'POST', url: '/api/hedges/preflight?case=two', headers: LOCAL_HEADERS, payload: payloadFor('2') });
  releaseTwo?.(); const second = await secondPromise;
  releaseOne?.(); const first = await firstPromise;
  for (const [response, label, quantity, ownError, otherError] of [
    [first, 'one', '1', 'ERROR-ONE', 'ERROR-TWO'],
    [second, 'two', '2', 'ERROR-TWO', 'ERROR-ONE']
  ] as const) {
    const requestId = response.json().requestId as string;
    const matches = completionLines(capture.lines()).filter((line) => line.reqId === requestId);
    assert.equal(matches.length, 1);
    const line = matches[0] as Record<string, unknown>;
    assert.equal((line.httpRequest as { url: string }).url, `/api/hedges/preflight?case=${label}`);
    assert.equal(((line.httpRequest as { body: { requestedBaseQuantity: string } }).body).requestedBaseQuantity, quantity);
    assert.equal(
      parseErrorDetail(
        (line.httpError as { error: unknown }).error
      ).code,
      'REQUEST_OPERATION_FAILED'
    );
    assert.doesNotMatch(JSON.stringify(line.httpError), new RegExp(ownError));
    assert.doesNotMatch(JSON.stringify(line), new RegExp(otherError));
  }
});

test('HTTP completion logger faults do not change persistence preflight count or background queueing', async (t) => {
  for (const mode of ['throw', 'reject'] as const) {
    let preflightRuns = 0;
    let executionRuns = 0;
    let unhandled: unknown;
    const onUnhandled = (reason: unknown): void => { unhandled = reason; };
    process.on('unhandledRejection', onUnhandled);
    try {
      const database = new Database(':memory:');
      const targetRepository = new SqliteStrategyRepository(database);
      let createPendingCalls = 0;
      const repository = new Proxy<StrategyRepository>(targetRepository, {
        get(target, property) {
          const value = Reflect.get(target, property);
          if (property === 'createPending') {
            return (...args: unknown[]) => {
              createPendingCalls += 1;
              return Reflect.apply(value as (...args: unknown[]) => unknown, target, args);
            };
          }
          return typeof value === 'function' ? value.bind(target) : value;
        }
      });
      t.after(() => database.close());
      const fixture = setup(t, {
        repository,
        loggerInstance: faultingCompletionLogger(mode),
        runPreflight: async (input) => {
          preflightRuns += 1;
          if (input.requestedBaseQuantity === '2') throw new Error('rejected');
          return preflight(input);
        },
        confirmAndExecute: async () => { executionRuns += 1; }
      });
      const created = await fixture.server.inject({ method: 'POST', url: '/api/hedges/preflight', headers: LOCAL_HEADERS, payload: { spotExchangeId: 'bitget', contractExchangeId: 'okx', symbol: SYMBOL, requestedBaseQuantity: '1', mode: 'SPOT_FIRST' } });
      assert.equal(created.statusCode, 201, mode);
      assert.equal(createPendingCalls, 1, mode);
      assert.equal(targetRepository.getStrategy(created.json().id).state, 'PENDING_CONFIRMATION', mode);
      const rejected = await fixture.server.inject({ method: 'POST', url: '/api/hedges/preflight', headers: LOCAL_HEADERS, payload: { spotExchangeId: 'bitget', contractExchangeId: 'okx', symbol: SYMBOL, requestedBaseQuantity: '2', mode: 'SPOT_FIRST' } });
      assert.equal(rejected.statusCode, 500, mode);
      assert.equal(preflightRuns, 2, mode);
      assert.equal(createPendingCalls, 1, mode);
      const confirmed = await fixture.server.inject({ method: 'POST', url: `/api/hedges/${created.json().id}/confirm`, headers: LOCAL_HEADERS, payload: { riskAcknowledged: true } });
      assert.equal(confirmed.statusCode, 202, mode);
      await flushImmediate();
      assert.equal(executionRuns, 1, mode);
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(unhandled, undefined, mode);
    } finally {
      process.removeListener('unhandledRejection', onUnhandled);
    }
  }
});

test('hostile parsed body getter safely degrades without invoking attacker code', async (t) => {
  const capture = completionCapture();
  const { server } = setup(t, { loggerInstance: capture.logger });
  let getterCalls = 0;
  server.post('/test/hostile-parsed', async (request, reply) => {
    const hostile = {};
    Object.defineProperty(hostile, 'secret', {
      enumerable: true,
      get(): never {
        getterCalls += 1;
        throw new Error('GETTER-SENTINEL');
      }
    });
    (request as unknown as { body: unknown }).body = hostile;
    return reply.status(418).send({ failed: true });
  });
  const response = await server.inject({ method: 'POST', url: '/test/hostile-parsed', headers: LOCAL_HEADERS, payload: { benign: true } });
  assert.equal(response.statusCode, 418);
  assert.equal(getterCalls, 0);
  const snapshot = completionForStatus(capture.lines(), 418).httpRequest as Record<string, unknown>;
  assert.equal(snapshot.body, null);
  assert.doesNotMatch(JSON.stringify(snapshot), /GETTER-SENTINEL/);
});

test('operator docs describe failure request snapshots and safety boundaries', async () => {
  const documents = await Promise.all([
    readFile(resolve(process.cwd(), 'README.md'), 'utf8'),
    readFile(resolve(process.cwd(), 'docs/usage/operator-guide.md'), 'utf8')
  ]);
  for (const document of documents) {
    for (const required of [
      'request completed', 'httpError', 'httpRequest', 'method', 'url', 'body',
      'truncated', 'originalByteLength', '1 MiB', '8192', 'headers',
      '响应 body', 'SQLite', 'unhandled_http_request_failure',
      'background_confirmation_failed'
    ]) assert.match(document, new RegExp(required));
    assert.match(document, /低于.*400.*info|info.*低于.*400/);
    assert.match(document, /4xx.*warn/);
    assert.match(document, /5xx.*error/);
    assert.match(document, /包含 query|含 query/);
    assert.match(document, /Host\/Origin.*(?:body|parser).*(?:之前|前)/);
    assert.match(document, /403.*body.*null/);
    assert.match(document, /路由.*(?:更大|较大).*(?:不会扩大|不会扩展).*(?:1 MiB|观察预算)/);
    assert.match(document, /配置.*敏感值.*(?:替换|脱敏)/);
    assert.match(document, /失败.*预检|预检失败/);
  }
});
