import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AuthenticationError,
  NetworkError,
  OrderNotFound,
  PermissionDenied,
  bitget as BitgetCcxtAdapter,
  okx as OkxCcxtAdapter,
  functions
} from 'ccxt';
import {
  loadExchangeCredentials
} from '../../src/config/exchange-credentials.js';
import { makeClientOrderId } from '../../src/domain/client-order-id.js';
import type {
  MarketKind,
  OrderRequest,
  OrderSnapshot
} from '../../src/domain/types.js';
import {
  CcxtExchangeGateway,
  type CcxtExchangeLike,
  type CcxtMarket,
  type CcxtOrder
} from '../../src/exchanges/ccxt-exchange-gateway.js';
import {
  NoOrderSubmittedError
} from '../../src/exchanges/exchange-gateway.js';
import {
  buildCreateOrderParams
} from '../../src/exchanges/exchange-profile.js';
import { ExchangeRegistry } from '../../src/exchanges/exchange-registry.js';

function market(overrides: Partial<CcxtMarket> = {}): CcxtMarket {
  return {
    id: 'BTCUSDT',
    symbol: 'BTC/USDT',
    base: 'BTC',
    quote: 'USDT',
    settle: undefined,
    type: 'spot',
    spot: true,
    margin: false,
    swap: false,
    future: false,
    option: false,
    contract: false,
    linear: undefined,
    inverse: undefined,
    active: true,
    contractSize: undefined,
    precision: {
      amount: 0.000001,
      price: 0.1
    },
    limits: {
      amount: { min: 0.000001, max: 1000 },
      price: { min: 0.1, max: 10000000 },
      cost: { min: 1, max: 100000000 }
    },
    info: {},
    ...overrides
  };
}

function swapMarket(overrides: Partial<CcxtMarket> = {}): CcxtMarket {
  return market({
    id: 'BTC-USDT-SWAP',
    symbol: 'BTC/USDT:USDT',
    settle: 'USDT',
    type: 'swap',
    spot: false,
    swap: true,
    contract: true,
    linear: true,
    inverse: false,
    contractSize: 0.001,
    precision: {
      amount: 1,
      price: 0.1
    },
    limits: {
      amount: { min: 1, max: undefined },
      price: { min: 0.1, max: 10000000 },
      cost: { min: 1, max: 100000000 }
    },
    ...overrides
  });
}

function bitgetSwapMarket(
  overrides: Partial<CcxtMarket> = {}
): CcxtMarket {
  return swapMarket({
    id: 'BTCUSDT',
    contractSize: 1,
    precision: {
      amount: 0.001,
      price: 0.1
    },
    limits: {
      amount: { min: 0.001, max: undefined },
      price: { min: undefined, max: undefined },
      cost: { min: 5, max: undefined }
    },
    ...overrides
  });
}

function okxSpotMarket(
  overrides: Partial<CcxtMarket> = {}
): CcxtMarket {
  return market({
    id: 'BTC-USDT',
    limits: {
      amount: { min: 0.000001, max: undefined },
      price: { min: undefined, max: undefined },
      cost: { min: undefined, max: 100000000 }
    },
    ...overrides
  });
}

function classicBitgetSpotMarket(
  rawMinimum: unknown = '0',
  unifiedMinimum: unknown = 0,
  amountStep: unknown = 0.000001,
  costMinimum: unknown = 1
): CcxtMarket {
  return market({
    info: { minTradeAmount: rawMinimum },
    precision: {
      amount: amountStep as CcxtMarket['precision']['amount'],
      price: 0.1
    },
    limits: {
      amount: {
        min: unifiedMinimum as CcxtMarket['limits']['amount']['min'],
        max: 1000
      },
      price: { min: 0.1, max: 10000000 },
      cost: {
        min: costMinimum as CcxtMarket['limits']['cost']['min'],
        max: 100000000
      }
    }
  });
}

function ccxtOrder(overrides: Partial<CcxtOrder> = {}): CcxtOrder {
  return {
    id: 'exchange-order-1',
    clientOrderId: 'clientorderid0000000000000000001',
    timestamp: 1785024000000,
    datetime: '2026-07-26T00:00:00.000Z',
    lastTradeTimestamp: undefined,
    lastUpdateTimestamp: 1785024000000,
    status: 'open',
    symbol: 'BTC/USDT',
    type: 'limit',
    timeInForce: 'GTC',
    side: 'buy',
    price: 60000,
    average: 60000,
    amount: 0.01,
    filled: 0,
    remaining: 0.01,
    cost: 0,
    trades: [],
    fees: [],
    fee: undefined,
    info: {},
    ...overrides
  };
}

interface CreateCall {
  symbol: string;
  type: string;
  side: string;
  amount: string;
  price: string | undefined;
  params: Record<string, unknown>;
}

interface FetchOrderCall {
  id: string;
  symbol: string | undefined;
  params: Record<string, unknown>;
}

class CcxtDouble implements CcxtExchangeLike {
  readonly has = {
    fetchOpenOrders: true,
    fetchClosedOrders: true,
    fetchPositionMode: true,
    fetchLeverage: true,
    fetchPositions: true
  };
  precisionMode = functions.TICK_SIZE;
  readonly markets: Record<string, CcxtMarket> = {};
  readonly events: string[] = [];
  readonly createCalls: CreateCall[] = [];
  readonly fetchOrderCalls: FetchOrderCall[] = [];
  readonly balanceCalls: Array<Record<string, unknown>> = [];
  readonly setMarginModeCalls: Array<{
    marginMode: string;
    symbol: string | undefined;
  }> = [];
  readonly openOrderCalls: string[] = [];
  readonly closedOrderCalls: string[] = [];
  amountPrecisionResult: string | undefined;
  pricePrecisionResult: string | undefined;
  ticker: {
    ask?: number | string;
    bid?: number | string;
    last?: number | string;
  } = {
    ask: 60001,
    bid: 59999,
    last: 60000
  };
  balance: Record<string, unknown> = {
    free: { USDT: 1234.5 },
    used: { USDT: 0 },
    total: { USDT: 1234.5 },
    USDT: { free: 1234.5, used: 0, total: 1234.5 },
    info: {}
  };
  createResult: CcxtOrder = ccxtOrder();
  createError: Error | undefined;
  fetchOrderResult: CcxtOrder = ccxtOrder();
  fetchOrderError: unknown;
  openOrders: CcxtOrder[] = [];
  closedOrders: CcxtOrder[] = [];
  positions: Array<Record<string, unknown>> = [];
  leverage: Record<string, unknown> = {
    info: {
      marginMode: 'crossed',
      posMode: 'one_way_mode'
    },
    symbol: 'BTC/USDT:USDT',
    marginMode: 'cross',
    longLeverage: 3,
    shortLeverage: 3
  };
  positionMode: Record<string, unknown> = {
    info: { posMode: 'net_mode' },
    hedged: false
  };

  constructor(readonly id: 'bitget' | 'okx') {}

  async loadMarkets(): Promise<Record<string, CcxtMarket>> {
    this.events.push('loadMarkets');
    return this.markets;
  }

  amountToPrecision(symbol: string, amount: number): string {
    const value = String(amount);
    this.events.push(`amountToPrecision:${symbol}:${value}`);
    return this.amountPrecisionResult ?? value;
  }

  priceToPrecision(symbol: string, price: number): string {
    const value = String(price);
    this.events.push(`priceToPrecision:${symbol}:${value}`);
    return this.pricePrecisionResult ?? value;
  }

  async fetchBalance(
    params: Record<string, unknown> = {}
  ): Promise<Record<string, unknown>> {
    this.events.push('fetchBalance');
    this.balanceCalls.push(structuredClone(params));
    return this.balance;
  }

  async fetchTicker(
    symbol: string
  ): Promise<{
    ask?: number | string;
    bid?: number | string;
    last?: number | string;
  }> {
    this.events.push(`fetchTicker:${symbol}`);
    return this.ticker;
  }

  async createOrder(
    symbol: string,
    type: string,
    side: string,
    amount: number,
    price: number | undefined,
    params: Record<string, unknown>
  ): Promise<CcxtOrder> {
    const call = {
      symbol,
      type,
      side,
      amount: String(amount),
      price: price === undefined ? undefined : String(price),
      params: structuredClone(params)
    };
    this.events.push(`createOrder:${symbol}`);
    this.createCalls.push(call);
    if (this.createError !== undefined) {
      throw this.createError;
    }
    return structuredClone(this.createResult);
  }

  async fetchOrder(
    id: string,
    symbol?: string,
    params: Record<string, unknown> = {}
  ): Promise<CcxtOrder> {
    this.events.push(`fetchOrder:${symbol ?? ''}`);
    this.fetchOrderCalls.push({
      id,
      symbol,
      params: structuredClone(params)
    });
    if (this.fetchOrderError !== undefined) {
      throw this.fetchOrderError;
    }
    return structuredClone(this.fetchOrderResult);
  }

  async fetchOpenOrders(symbol?: string): Promise<CcxtOrder[]> {
    this.events.push(`fetchOpenOrders:${symbol ?? ''}`);
    this.openOrderCalls.push(symbol ?? '');
    return structuredClone(this.openOrders);
  }

  async fetchClosedOrders(symbol?: string): Promise<CcxtOrder[]> {
    this.events.push(`fetchClosedOrders:${symbol ?? ''}`);
    this.closedOrderCalls.push(symbol ?? '');
    return structuredClone(this.closedOrders);
  }

  async fetchPositions(
    symbols?: string[]
  ): Promise<Array<Record<string, unknown>>> {
    this.events.push(`fetchPositions:${symbols?.join(',') ?? ''}`);
    return structuredClone(this.positions);
  }

  async fetchLeverage(symbol: string): Promise<Record<string, unknown>> {
    this.events.push(`fetchLeverage:${symbol}`);
    return structuredClone(this.leverage);
  }

  async fetchPositionMode(symbol?: string): Promise<Record<string, unknown>> {
    this.events.push(`fetchPositionMode:${symbol ?? ''}`);
    return structuredClone(this.positionMode);
  }

  async setMarginMode(
    marginMode: string,
    symbol?: string
  ): Promise<Record<string, unknown>> {
    this.setMarginModeCalls.push({ marginMode, symbol });
    return {};
  }
}

function makeGateway(
  exchangeId: 'bitget' | 'okx',
  markets: CcxtMarket[] = exchangeId === 'bitget'
    ? [market(), bitgetSwapMarket()]
    : [okxSpotMarket(), swapMarket()]
): { gateway: CcxtExchangeGateway; ccxt: CcxtDouble } {
  const ccxt = new CcxtDouble(exchangeId);
  for (const configuredMarket of markets) {
    ccxt.markets[configuredMarket.symbol] = configuredMarket;
  }
  return {
    gateway: new CcxtExchangeGateway(exchangeId, ccxt),
    ccxt
  };
}

function isNoOrderSubmitted(error: unknown): boolean {
  assert(error instanceof NoOrderSubmittedError);
  assert.equal(error.message, 'order was not submitted');
  assert.equal(error.code, 'NO_ORDER_SUBMITTED');
  return true;
}

function swapRequest(
  overrides: Partial<OrderRequest> = {}
): OrderRequest {
  return {
    symbol: 'BTC/USDT',
    kind: 'swap',
    type: 'limit',
    side: 'sell',
    baseQuantity: '0.01',
    price: '60000',
    timeInForce: 'GTC',
    clientOrderId: 'clientorderid0000000000000000001',
    marginMode: 'cross',
    ...overrides
  };
}

function spotRequest(
  overrides: Partial<OrderRequest> = {}
): OrderRequest {
  return {
    symbol: 'BTC/USDT',
    kind: 'spot',
    type: 'limit',
    side: 'buy',
    baseQuantity: '0.01',
    price: '60000',
    timeInForce: 'GTC',
    clientOrderId: 'clientorderid0000000000000000001',
    ...overrides
  };
}

function spotMarketRequest(
  side: 'buy' | 'sell' = 'buy'
): OrderRequest {
  return {
    symbol: 'BTC/USDT',
    kind: 'spot',
    type: 'market',
    side,
    baseQuantity: '0.01',
    clientOrderId: 'clientorderid0000000000000000001'
  };
}

test('loads exchange credentials only from the supplied environment', () => {
  const credentials = loadExchangeCredentials('bitget', {
    TRADING_BITGET_API_KEY: 'api-key-value',
    TRADING_BITGET_SECRET: 'secret-value',
    TRADING_BITGET_PASSWORD: 'password-value'
  });

  assert.deepEqual(credentials, {
    apiKey: 'api-key-value',
    secret: 'secret-value',
    password: 'password-value'
  });
});

test('credential errors never include credential values', () => {
  const secret = 'do-not-leak-this-secret';
  assert.throws(
    () => loadExchangeCredentials('okx', {
      TRADING_OKX_API_KEY: secret
    }),
    (error: unknown) => {
      assert(error instanceof Error);
      assert.match(error.message, /missing credentials.*okx/);
      assert.doesNotMatch(error.message, new RegExp(secret));
      return true;
    }
  );
});

for (const exchangeId of ['bitget', 'okx'] as const) {
  test(`${exchangeId} requires a non-empty exchange password`, () => {
    const apiKey = `${exchangeId}-api-key-do-not-leak`;
    const secret = `${exchangeId}-secret-do-not-leak`;
    const prefix = `TRADING_${exchangeId.toUpperCase()}`;
    const env = {
      [`${prefix}_API_KEY`]: apiKey,
      [`${prefix}_SECRET`]: secret
    };

    for (const password of [undefined, '   ']) {
      assert.throws(
        () => loadExchangeCredentials(exchangeId, {
          ...env,
          ...(password === undefined
            ? {}
            : { [`${prefix}_PASSWORD`]: password })
        }),
        (error: unknown) => {
          assert(error instanceof Error);
          assert.match(error.message, /missing credentials/);
          assert.doesNotMatch(error.message, new RegExp(apiKey));
          assert.doesNotMatch(error.message, new RegExp(secret));
          return true;
        }
      );
    }
  });
}

test('loads an evidenced Bitget Classic spot zero minimum as one amount step', async () => {
  const { gateway } = makeGateway('bitget', [classicBitgetSpotMarket()]);

  const rules = await gateway.loadMarket('BTC/USDT', 'spot');

  assert.equal(rules.amountStep, '0.000001');
  assert.equal(rules.minBaseAmount, '0.000001');
  assert.equal(rules.minQuoteNotional, '1');
  assert.equal(rules.maxBaseAmount, '1000');
  assert.equal(rules.maxQuoteNotional, '100000000');
});

for (const [name, rawMinimum, unifiedMinimum] of [
  ['number zero', 0, 0],
  ['negative zero', -0, -0],
  ['decimal string zero', '0.0', '0.000'],
  ['exponent string zero', ' 0e10 ', ' -0e-3 ']
] as const) {
  test(`accepts Classic exact decimal zero representation: ${name}`, async () => {
    const { gateway } = makeGateway('bitget', [
      classicBitgetSpotMarket(rawMinimum, unifiedMinimum)
    ]);
    const rules = await gateway.loadMarket('BTC/USDT', 'spot');
    assert.equal(rules.minBaseAmount, '0.000001');
    assert.equal(rules.minQuoteNotional, '1');
  });
}

test('keeps a positive unified Bitget spot minimum without raw compatibility evidence', async () => {
  const configured = classicBitgetSpotMarket('not-a-decimal', '0.01');
  const { gateway } = makeGateway('bitget', [configured]);

  const rules = await gateway.loadMarket('BTC/USDT', 'spot');

  assert.equal(rules.minBaseAmount, '0.01');
  assert.equal(rules.minQuoteNotional, '1');
});

test('does not apply Bitget compatibility to OKX spot', async () => {
  const forged = okxSpotMarket({
    info: { minTradeAmount: '0' },
    limits: {
      amount: { min: 0, max: undefined },
      price: { min: undefined, max: undefined },
      cost: { min: 1, max: 100000000 }
    }
  });
  const { gateway } = makeGateway('okx', [forged]);

  await assert.rejects(
    gateway.loadMarket('BTC/USDT', 'spot'),
    /minimum amount limit/
  );
});

test('does not apply Classic spot compatibility to Bitget swap', async () => {
  const configured = bitgetSwapMarket({
    info: { minTradeAmount: '0' },
    limits: {
      amount: { min: 0, max: undefined },
      price: { min: undefined, max: undefined },
      cost: { min: 5, max: undefined }
    }
  });
  const { gateway } = makeGateway('bitget', [configured]);

  await assert.rejects(
    gateway.loadMarket('BTC/USDT', 'swap'),
    /minimum amount limit/
  );
});

for (const [name, info] of [
  ['undefined', undefined],
  ['null', null],
  ['array', []],
  ['string', 'classic'],
  ['number', 0]
] as const) {
  test(`rejects Classic zero minimum when info is ${name}`, async () => {
    const configured = classicBitgetSpotMarket();
    configured.info = info;
    const { gateway } = makeGateway('bitget', [configured]);
    await assert.rejects(
      gateway.loadMarket('BTC/USDT', 'spot'),
      /minimum amount limit/
    );
  });
}

for (const [name, rawMinimum] of [
  ['missing', undefined],
  ['null', null],
  ['empty', ''],
  ['whitespace', '   '],
  ['boolean', false],
  ['object', {}],
  ['array', []],
  ['negative', -1],
  ['positive', 1],
  ['NaN number', Number.NaN],
  ['infinite number', Number.POSITIVE_INFINITY],
  ['NaN string', 'NaN'],
  ['infinite string', 'Infinity'],
  ['malformed string', 'zero']
] as const) {
  test(`rejects Classic unified zero with raw minimum ${name}`, async () => {
    const configured = classicBitgetSpotMarket(rawMinimum);
    if (name === 'missing') {
      delete (configured.info as Record<string, unknown>).minTradeAmount;
    }
    const { gateway } = makeGateway('bitget', [configured]);
    await assert.rejects(
      gateway.loadMarket('BTC/USDT', 'spot'),
      /minimum amount limit/
    );
  });
}

const invalidDecimalMetadata: ReadonlyArray<[string, unknown]> = [
  ['missing', undefined],
  ['empty', ''],
  ['negative', -1],
  ['NaN number', Number.NaN],
  ['infinite number', Number.POSITIVE_INFINITY],
  ['NaN string', 'NaN'],
  ['infinite string', 'Infinity'],
  ['malformed string', 'invalid']
];

for (const [name, unifiedMinimum] of invalidDecimalMetadata) {
  test(`rejects invalid unified Classic amount minimum: ${name}`, async () => {
    const configured = classicBitgetSpotMarket('0', unifiedMinimum);
    if (name === 'missing') {
      configured.limits.amount.min = undefined;
    }
    const { gateway } = makeGateway('bitget', [configured]);
    await assert.rejects(gateway.loadMarket('BTC/USDT', 'spot'));
  });
}

for (const [name, amountStep] of [
  ...invalidDecimalMetadata,
  ['zero', 0] as const
]) {
  test(`rejects Classic compatibility with invalid amount step: ${name}`, async () => {
    const configured = classicBitgetSpotMarket('0', 0, amountStep);
    if (name === 'missing') {
      configured.precision.amount = undefined;
    }
    const { gateway } = makeGateway('bitget', [configured]);
    await assert.rejects(
      gateway.loadMarket('BTC/USDT', 'spot'),
      /amount precision/
    );
  });
}

for (const [name, costMinimum] of [
  ...invalidDecimalMetadata,
  ['zero', 0] as const
]) {
  test(`rejects Classic compatibility with invalid quote minimum: ${name}`, async () => {
    const configured = classicBitgetSpotMarket(
      '0',
      0,
      0.000001,
      costMinimum
    );
    if (name === 'missing') {
      configured.limits.cost.min = undefined;
    }
    const { gateway } = makeGateway('bitget', [configured]);
    if (name === 'missing') {
      await assert.rejects(gateway.loadMarket('BTC/USDT', 'spot'));
    } else {
      await assert.rejects(
        gateway.loadMarket('BTC/USDT', 'spot'),
        /minimum quote notional/
      );
    }
  });
}

test('rejects a compatible Classic minimum when maximum amount is below its step', async () => {
  const configured = classicBitgetSpotMarket();
  configured.limits.amount.max = '0.0000001';
  const { gateway } = makeGateway('bitget', [configured]);

  await assert.rejects(
    gateway.loadMarket('BTC/USDT', 'spot'),
    /invalid base amount range/
  );
});

test('creates deterministic 32-character lowercase alphanumeric client ids', () => {
  const id = makeClientOrderId('strategy-uuid', 'CONTRACT_HEDGE_GTC');
  assert.match(id, /^[a-z0-9]{32}$/);
  assert.equal(
    id,
    makeClientOrderId('strategy-uuid', 'CONTRACT_HEDGE_GTC')
  );
  assert.notEqual(
    id,
    makeClientOrderId('strategy-uuid', 'SPOT_HEDGE_GTC')
  );
  assert.notEqual(id, 'strategy-uuid:CONTRACT_HEDGE_GTC');
});

test('buildCreateOrderParams has the prescribed pure unified behavior', () => {
  assert.deepEqual(buildCreateOrderParams(swapRequest({
    positionSide: 'SHORT'
  })), {
    clientOrderId: 'clientorderid0000000000000000001',
    timeInForce: 'GTC',
    reduceOnly: false,
    marginMode: 'cross',
    positionSide: 'SHORT'
  });
});

for (const exchangeId of ['bitget', 'okx'] as const) {
  test(`${exchangeId} normalizes a linear swap amount into base quantity`, async () => {
    const { gateway } = makeGateway(exchangeId);

    const rules = await gateway.loadMarket('BTC/USDT', 'swap');

    assert.deepEqual(rules, {
      exchangeId,
      symbol: 'BTC/USDT',
      marketId: exchangeId === 'bitget'
        ? 'BTCUSDT'
        : 'BTC-USDT-SWAP',
      kind: 'swap',
      base: 'BTC',
      quote: 'USDT',
      active: true,
      amountStep: exchangeId === 'bitget' ? '0.001' : '1',
      contractSize: exchangeId === 'bitget' ? '1' : '0.001',
      minBaseAmount: '0.001',
      priceStep: '0.1',
      minQuoteNotional: exchangeId === 'bitget' ? '5' : '1',
      ...(exchangeId === 'okx'
        ? { maxQuoteNotional: '100000000' }
        : {})
    });
  });

  test(`${exchangeId} normalizes a spot market without inventing a contract multiplier`, async () => {
    const { gateway } = makeGateway(exchangeId);

    const rules = await gateway.loadMarket('BTC/USDT', 'spot');

    assert.equal(rules.amountStep, '0.000001');
    assert.equal(rules.contractSize, '1');
    assert.equal(rules.minBaseAmount, '0.000001');
    assert.equal(
      rules.maxBaseAmount,
      exchangeId === 'bitget' ? '1000' : undefined
    );
    assert.equal(
      rules.minQuoteNotional,
      exchangeId === 'bitget' ? '1' : undefined
    );
  });

  test(`${exchangeId} converts swap order contracts and fills back to base quantity`, async () => {
    const { gateway, ccxt } = makeGateway(exchangeId);
    const amount = exchangeId === 'bitget' ? 0.01 : 10;
    const filled = exchangeId === 'bitget' ? 0.004 : 4;
    const remaining = exchangeId === 'bitget' ? 0.006 : 6;
    ccxt.fetchOrderResult = ccxtOrder({
      symbol: 'BTC/USDT:USDT',
      type: 'limit',
      side: 'sell',
      amount,
      filled,
      remaining,
      average: 60001.5,
      status: 'open'
    });

    const snapshot = await gateway.fetchOrder(
      'exchange-order-1',
      'BTC/USDT',
      'swap'
    );

    assert.deepEqual(snapshot, {
      exchangeId,
      exchangeOrderId: 'exchange-order-1',
      clientOrderId: 'clientorderid0000000000000000001',
      symbol: 'BTC/USDT',
      kind: 'swap',
      type: 'limit',
      side: 'sell',
      requestedBaseQuantity: '0.01',
      filledBaseQuantity: '0.004',
      remainingBaseQuantity: '0.006',
      averagePrice: '60001.5',
      status: 'open',
      updatedAt: '2026-07-26T00:00:00.000Z'
    });
  });

  test(`${exchangeId} preserves a zero spot fill and full remaining base quantity`, async () => {
    const { gateway, ccxt } = makeGateway(exchangeId);
    ccxt.fetchOrderResult = ccxtOrder({
      amount: 0.01,
      filled: 0,
      remaining: 0.01,
      average: undefined
    });

    const snapshot = await gateway.fetchOrder(
      'exchange-order-1',
      'BTC/USDT',
      'spot'
    );

    assert.equal(snapshot.filledBaseQuantity, '0');
    assert.equal(snapshot.remainingBaseQuantity, '0.01');
    assert.equal(snapshot.averagePrice, null);
  });

  test(`${exchangeId} uses direct client-id fetch and never scans or submits`, async () => {
    const { gateway, ccxt } = makeGateway(exchangeId);
    const amount = exchangeId === 'bitget' ? 0.01 : 10;
    ccxt.fetchOrderResult = ccxtOrder({
      symbol: 'BTC/USDT:USDT',
      side: 'sell',
      amount,
      filled: 0,
      remaining: amount
    });

    const snapshot = await gateway.findOrderByClientId(
      'clientorderid0000000000000000001',
      'BTC/USDT',
      'swap'
    );

    assert(snapshot);
    assert.deepEqual(ccxt.fetchOrderCalls, [{
      id: 'clientorderid0000000000000000001',
      symbol: 'BTC/USDT:USDT',
      params: {
        clientOrderId: 'clientorderid0000000000000000001'
      }
    }]);
    assert.equal(ccxt.openOrderCalls.length, 0);
    assert.equal(ccxt.closedOrderCalls.length, 0);
    assert.equal(ccxt.createCalls.length, 0);
  });

  test(`${exchangeId} returns null only for CCXT OrderNotFound`, async () => {
    const { gateway, ccxt } = makeGateway(exchangeId);
    ccxt.fetchOrderError = new OrderNotFound(`${exchangeId} missing`);

    assert.equal(await gateway.findOrderByClientId(
      'clientorderid0000000000000000001',
      'BTC/USDT',
      'spot'
    ), null);
  });

  for (const exchangeError of [
    new AuthenticationError('auth failed'),
    new PermissionDenied('permission failed'),
    new NetworkError('network failed')
  ]) {
    test(`${exchangeId} propagates ${exchangeError.name} from direct client-id fetch`, async () => {
      const { gateway, ccxt } = makeGateway(exchangeId);
      ccxt.fetchOrderError = exchangeError;

      await assert.rejects(
        gateway.findOrderByClientId(
          'clientorderid0000000000000000001',
          'BTC/USDT',
          'spot'
        ),
        (error: unknown) => error === exchangeError
      );
    });
  }
}

test('fails closed for unsupported precision mode', async () => {
  const { gateway, ccxt } = makeGateway('bitget');
  ccxt.precisionMode = functions.SIGNIFICANT_DIGITS;
  await assert.rejects(
    gateway.loadMarket('BTC/USDT', 'swap'),
    /unsupported precision mode/
  );
});

for (const [label, brokenMarket] of [
  ['amount precision', swapMarket({
    precision: { amount: 0, price: 0.1 }
  })],
  ['price precision', swapMarket({
    precision: { amount: 1, price: undefined }
  })],
  ['minimum amount limit', swapMarket({
    limits: {
      amount: { min: undefined, max: undefined },
      price: { min: 0.1, max: 10000000 },
      cost: { min: 1, max: 100000000 }
    }
  })],
  ['maximum amount limit', swapMarket({
    limits: {
      amount: { min: 1, max: 0 },
      price: { min: 0.1, max: 10000000 },
      cost: { min: 1, max: 100000000 }
    }
  })],
  ['contract size', swapMarket({ contractSize: 0 })]
] as const) {
  test(`fails closed for invalid ${label}`, async () => {
    const { gateway } = makeGateway('okx', [brokenMarket]);
    await assert.rejects(
      gateway.loadMarket('BTC/USDT', 'swap'),
      new RegExp(label)
    );
  });
}

for (const [label, cost] of [
  ['minimum quote notional', { min: 0, max: undefined }],
  ['maximum quote notional', { min: 1, max: 0 }],
  ['quote notional range', { min: 10, max: 5 }]
] as const) {
  test(`fails closed for invalid ${label} metadata`, async () => {
    const brokenMarket = swapMarket({
      limits: {
        amount: { min: 1, max: undefined },
        price: { min: 0.1, max: 10000000 },
        cost
      }
    });
    const { gateway } = makeGateway('okx', [brokenMarket]);

    await assert.rejects(
      gateway.loadMarket('BTC/USDT', 'swap'),
      /quote notional/
    );
  });
}

for (const [label, rejectedMarket] of [
  ['inactive', swapMarket({ active: false })],
  ['inverse', swapMarket({ linear: false, inverse: true })],
  ['non-swap', swapMarket({ swap: false, future: true, type: 'future' })],
  ['non-USDT settled', swapMarket({ settle: 'BTC' })]
] as const) {
  test(`rejects ${label} swap candidates`, async () => {
    const { gateway } = makeGateway('bitget', [rejectedMarket]);
    await assert.rejects(
      gateway.loadMarket('BTC/USDT', 'swap'),
      /supported active linear USDT-settled swap/
    );
  });
}

test('quantizes a GTC price through the resolved exchange market', async () => {
  const { gateway, ccxt } = makeGateway('okx');
  ccxt.pricePrecisionResult = '60000.1';

  assert.equal(
    await gateway.quantizePrice('BTC/USDT', 'swap', '60000.19'),
    '60000.1'
  );
  assert.equal(
    ccxt.events.at(-1),
    'priceToPrecision:BTC/USDT:USDT:60000.19'
  );
});

test('omits an unavailable maximum amount instead of inventing one', async () => {
  const { gateway } = makeGateway('okx');

  const rules = await gateway.loadMarket('BTC/USDT', 'swap');

  assert.equal(rules.maxBaseAmount, undefined);
  assert.equal('maxBaseAmount' in rules, false);
});

function buildLockedAdapterOrderRequest(
  exchangeId: 'bitget' | 'okx',
  amount: number,
  params: Record<string, unknown>
): Record<string, unknown> {
  const adapter = exchangeId === 'bitget'
    ? new BitgetCcxtAdapter()
    : new OkxCcxtAdapter();
  const exchangeMarket = {
    ...swapMarket({
      id: exchangeId === 'bitget' ? 'BTCUSDT' : 'BTC-USDT-SWAP',
      contractSize: exchangeId === 'bitget' ? 1 : 0.001,
      precision: {
        amount: exchangeId === 'bitget' ? 0.001 : 1,
        price: 0.1
      }
    }),
    baseId: 'BTC',
    quoteId: 'USDT',
    settleId: 'USDT'
  };
  adapter.setMarkets([exchangeMarket as never]);
  return adapter.createOrderRequest(
    exchangeMarket.symbol,
    'limit',
    'sell',
    amount,
    60000,
    params
  ) as Record<string, unknown>;
}

for (const exchangeId of ['bitget', 'okx'] as const) {
  for (const marginMode of ['cross', 'isolated'] as const) {
    test(`${exchangeId} preserves ${marginMode} margin for a hedged opening short`, async () => {
        const { gateway, ccxt } = makeGateway(exchangeId);
        const exchangeAmount = exchangeId === 'bitget' ? 0.01 : 10;
        ccxt.createResult = ccxtOrder({
          symbol: 'BTC/USDT:USDT',
          type: 'limit',
          side: 'sell',
          amount: exchangeAmount,
          filled: 0,
          remaining: exchangeAmount
        });

        await gateway.createOrder(swapRequest({
          marginMode,
          positionSide: 'SHORT'
        }));

        const params = ccxt.createCalls[0]?.params;
        assert.deepEqual(params, {
          clientOrderId: 'clientorderid0000000000000000001',
          ...(exchangeId === 'bitget' ? { timeInForce: 'GTC' } : {}),
          reduceOnly: false,
          marginMode,
          ...(exchangeId === 'bitget'
            ? { hedged: true }
            : { positionSide: 'short' })
        });
        assert.equal(ccxt.setMarginModeCalls.length, 0);

        const lockedRequest = buildLockedAdapterOrderRequest(
          exchangeId,
          exchangeAmount,
          params ?? {}
        );
        if (exchangeId === 'bitget') {
          assert.equal(
            lockedRequest.marginMode,
            marginMode === 'cross' ? 'crossed' : 'isolated'
          );
          assert.equal(lockedRequest.force, 'GTC');
          assert.equal(
            lockedRequest.tradeSide,
            'Open'
          );
        } else {
          assert.equal(lockedRequest.tdMode, marginMode);
          assert.equal(lockedRequest.ordType, 'limit');
          assert.equal(
            lockedRequest.posSide,
            'short'
          );
        }
      });
  }
}

test('swap orders fail closed without a confirmed margin mode', async () => {
  const { gateway, ccxt } = makeGateway('bitget');
  const request = swapRequest();
  delete request.marginMode;

  await assert.rejects(
    gateway.createOrder(request),
    isNoOrderSubmitted
  );
  assert.equal(ccxt.createCalls.length, 0);
  assert.equal(ccxt.setMarginModeCalls.length, 0);
});

test('spot orders reject a contract margin mode instead of forwarding it', async () => {
  const { gateway, ccxt } = makeGateway('okx');
  const request = {
    symbol: 'BTC/USDT',
    kind: 'spot',
    type: 'limit',
    side: 'buy',
    baseQuantity: '0.01',
    price: '60000',
    clientOrderId: 'clientorderid0000000000000000001',
    marginMode: 'isolated'
  } as const;

  await assert.rejects(
    gateway.createOrder(request),
    isNoOrderSubmitted
  );
  assert.equal(ccxt.createCalls.length, 0);
});

test('all failures before the CCXT create call use the safe no-order-submitted type', async (t) => {
  const assertSafePreCallFailure = async (
    action: () => Promise<unknown>,
    ccxt: CcxtDouble
  ): Promise<void> => {
    await assert.rejects(action, isNoOrderSubmitted);
    assert.equal(ccxt.createCalls.length, 0);
  };

  await t.test('request validation', async () => {
    const { gateway, ccxt } = makeGateway('okx');
    const request = swapRequest();
    delete request.marginMode;
    await assertSafePreCallFailure(
      () => gateway.createOrder(request),
      ccxt
    );
  });

  await t.test('market resolution', async () => {
    const { gateway, ccxt } = makeGateway('okx');
    await assertSafePreCallFailure(
      () => gateway.createOrder(spotRequest({ symbol: 'ETH/USDT' })),
      ccxt
    );
  });

  await t.test('precision conversion', async () => {
    const { gateway, ccxt } = makeGateway('okx');
    ccxt.amountPrecisionResult = '9';
    await assertSafePreCallFailure(
      () => gateway.createOrder(swapRequest()),
      ccxt
    );
  });

  await t.test('minimum amount', async () => {
    const constrained = okxSpotMarket({
      precision: { amount: 0.001, price: 0.1 },
      limits: {
        amount: { min: 0.01, max: undefined },
        price: { min: undefined, max: undefined },
        cost: { min: undefined, max: undefined }
      }
    });
    const { gateway, ccxt } = makeGateway('okx', [constrained]);
    await assertSafePreCallFailure(
      () => gateway.createOrder(spotRequest({ baseQuantity: '0.005' })),
      ccxt
    );
  });

  await t.test('ticker lookup', async () => {
    const { gateway, ccxt } = makeGateway('bitget');
    ccxt.ticker = {};
    await assertSafePreCallFailure(
      () => gateway.createOrder(spotMarketRequest()),
      ccxt
    );
  });
});

test('actual CCXT create exceptions and post-call normalization failures remain uncertain', async (t) => {
  await t.test('create exception', async () => {
    const { gateway, ccxt } = makeGateway('okx');
    const createError = new NetworkError('uncertain network create');
    ccxt.createError = createError;

    await assert.rejects(
      gateway.createOrder(swapRequest()),
      (error: unknown) => error === createError
    );
    assert.equal(ccxt.createCalls.length, 1);
  });

  await t.test('normalization exception', async () => {
    const { gateway, ccxt } = makeGateway('okx');
    ccxt.createResult = ccxtOrder({ id: undefined });

    await assert.rejects(gateway.createOrder(swapRequest()), (error: unknown) => {
      assert(error instanceof Error);
      assert.equal(error instanceof NoOrderSubmittedError, false);
      return true;
    });
    assert.equal(ccxt.createCalls.length, 1);
  });
});

test('formats amount and price immediately before submission', async () => {
  const { gateway, ccxt } = makeGateway('okx');
  ccxt.amountPrecisionResult = '10';
  ccxt.pricePrecisionResult = '60000';
  ccxt.createResult = ccxtOrder({
    symbol: 'BTC/USDT:USDT',
    type: 'limit',
    side: 'sell',
    amount: 10,
    filled: 0,
    remaining: 10
  });

  await gateway.createOrder(swapRequest());

  assert.deepEqual(ccxt.events.slice(-3), [
    'amountToPrecision:BTC/USDT:USDT:10',
    'priceToPrecision:BTC/USDT:USDT:60000',
    'createOrder:BTC/USDT:USDT'
  ]);
});

test('rejects precision output that changes the pre-normalized base quantity', async () => {
  const { gateway, ccxt } = makeGateway('okx');
  ccxt.amountPrecisionResult = '9';

  await assert.rejects(
    gateway.createOrder(swapRequest()),
    isNoOrderSubmitted
  );
  assert.equal(ccxt.createCalls.length, 0);
});

test('keeps pre-submit amount and notional guards for compatible Classic spot', async (t) => {
  await t.test('below one amount step', async () => {
    const { gateway, ccxt } = makeGateway('bitget', [
      classicBitgetSpotMarket()
    ]);

    await assert.rejects(
      gateway.createOrder(spotRequest({
        baseQuantity: '0.0000001',
        price: '10000000'
      })),
      isNoOrderSubmitted
    );
    assert.equal(ccxt.createCalls.length, 0);
  });

  await t.test('not exactly representable at the amount step', async () => {
    const { gateway, ccxt } = makeGateway('bitget', [
      classicBitgetSpotMarket()
    ]);
    ccxt.amountPrecisionResult = '0.000001';

    await assert.rejects(
      gateway.createOrder(spotRequest({
        baseQuantity: '0.0000015',
        price: '1000000'
      })),
      isNoOrderSubmitted
    );
    assert.equal(ccxt.createCalls.length, 0);
  });

  await t.test('at one step but below minimum quote notional', async () => {
    const { gateway, ccxt } = makeGateway('bitget', [
      classicBitgetSpotMarket()
    ]);

    await assert.rejects(
      gateway.createOrder(spotRequest({
        baseQuantity: '0.000001',
        price: '100'
      })),
      isNoOrderSubmitted
    );
    assert.equal(ccxt.createCalls.length, 0);
  });
});

test('submits an eligible compatible Classic spot order with unchanged parameters', async () => {
  const { gateway, ccxt } = makeGateway('bitget', [
    classicBitgetSpotMarket()
  ]);
  ccxt.createResult = ccxtOrder({
    symbol: 'BTC/USDT',
    type: 'limit',
    side: 'buy',
    amount: '0.00002',
    filled: '0',
    remaining: '0.00002'
  });

  await gateway.createOrder(spotRequest({
    baseQuantity: '0.00002',
    price: '60000'
  }));

  assert.deepEqual(ccxt.createCalls, [{
    symbol: 'BTC/USDT',
    type: 'limit',
    side: 'buy',
    amount: '0.00002',
    price: '60000',
    params: {
      clientOrderId: 'clientorderid0000000000000000001',
      timeInForce: 'GTC'
    }
  }]);
});

test('submits exactly one compatible Classic spot amount step at the quote minimum', async () => {
  const { gateway, ccxt } = makeGateway('bitget', [
    classicBitgetSpotMarket()
  ]);
  ccxt.createResult = ccxtOrder({
    symbol: 'BTC/USDT',
    type: 'limit',
    side: 'buy',
    price: '1000000',
    amount: '0.000001',
    filled: '0',
    remaining: '0.000001'
  });

  await gateway.createOrder(spotRequest({
    baseQuantity: '0.000001',
    price: '1000000'
  }));

  assert.deepEqual(ccxt.createCalls, [{
    symbol: 'BTC/USDT',
    type: 'limit',
    side: 'buy',
    amount: '0.000001',
    price: '1000000',
    params: {
      clientOrderId: 'clientorderid0000000000000000001',
      timeInForce: 'GTC'
    }
  }]);
});

for (const [label, baseQuantity] of [
  ['minimum', '0.005'],
  ['maximum', '0.03']
] as const) {
  test(`blocks a create below or above the base ${label}`, async () => {
    const constrained = okxSpotMarket({
      precision: { amount: 0.001, price: 0.1 },
      limits: {
        amount: { min: 0.01, max: 0.02 },
        price: { min: undefined, max: undefined },
        cost: { min: undefined, max: undefined }
      }
    });
    const { gateway, ccxt } = makeGateway('okx', [constrained]);

    await assert.rejects(
      gateway.createOrder(spotRequest({ baseQuantity })),
      isNoOrderSubmitted
    );
    assert.equal(ccxt.createCalls.length, 0);
  });
}

test('uses the formatted limit price to block a sub-minimum quote notional', async () => {
  const constrained = okxSpotMarket({
    limits: {
      amount: { min: 0.000001, max: undefined },
      price: { min: undefined, max: undefined },
      cost: { min: 650, max: undefined }
    }
  });
  const { gateway, ccxt } = makeGateway('okx', [constrained]);
  ccxt.pricePrecisionResult = '60000';

  await assert.rejects(
    gateway.createOrder(spotRequest({ price: '65000' })),
    isNoOrderSubmitted
  );
  assert.equal(ccxt.createCalls.length, 0);
});

test('blocks a Bitget spot market buy below quote minimum using its conversion ask', async () => {
  const constrained = market({
    limits: {
      amount: { min: 0.000001, max: 1000 },
      price: { min: 0.1, max: 10000000 },
      cost: { min: 700, max: undefined }
    }
  });
  const { gateway, ccxt } = makeGateway('bitget', [constrained]);
  ccxt.ticker = { ask: 60000, last: 80000 };

  await assert.rejects(
    gateway.createOrder(spotMarketRequest()),
    isNoOrderSubmitted
  );
  assert.equal(ccxt.createCalls.length, 0);
});

test('uses bid before last to block a market sell below quote minimum', async () => {
  const constrained = okxSpotMarket({
    limits: {
      amount: { min: 0.000001, max: undefined },
      price: { min: undefined, max: undefined },
      cost: { min: 650, max: undefined }
    }
  });
  const { gateway, ccxt } = makeGateway('okx', [constrained]);
  ccxt.ticker = { bid: 60000, last: 70000 };

  await assert.rejects(
    gateway.createOrder(spotMarketRequest('sell')),
    isNoOrderSubmitted
  );
  assert.equal(ccxt.createCalls.length, 0);
});

test('uses ask for market-buy quote validation without forwarding a fill price', async () => {
  const constrained = okxSpotMarket({
    limits: {
      amount: { min: 0.000001, max: undefined },
      price: { min: undefined, max: undefined },
      cost: { min: 650, max: undefined }
    }
  });
  const { gateway, ccxt } = makeGateway('okx', [constrained]);
  ccxt.ticker = { ask: 70000, last: 50000 };
  ccxt.createResult = ccxtOrder({
    type: 'market',
    side: 'buy',
    amount: 0.01,
    filled: 0,
    remaining: 0.01,
    average: undefined
  });

  const snapshot = await gateway.createOrder(spotMarketRequest());

  assert.equal(ccxt.createCalls[0]?.price, undefined);
  assert.equal(snapshot.averagePrice, null);
  assert(ccxt.events.includes('fetchTicker:BTC/USDT'));
});

test('falls back to last for market quote validation without forwarding it', async () => {
  const constrained = okxSpotMarket({
    limits: {
      amount: { min: 0.000001, max: undefined },
      price: { min: undefined, max: undefined },
      cost: { min: 650, max: undefined }
    }
  });
  const { gateway, ccxt } = makeGateway('okx', [constrained]);
  ccxt.ticker = { last: 70000 };
  ccxt.createResult = ccxtOrder({
    type: 'market',
    side: 'sell',
    amount: 0.01,
    filled: 0,
    remaining: 0.01,
    average: undefined
  });

  await gateway.createOrder(spotMarketRequest('sell'));

  assert.equal(ccxt.createCalls[0]?.price, undefined);
  assert(ccxt.events.includes('fetchTicker:BTC/USDT'));
});

test('blocks a create above the maximum quote notional', async () => {
  const constrained = okxSpotMarket({
    limits: {
      amount: { min: 0.000001, max: undefined },
      price: { min: undefined, max: undefined },
      cost: { min: undefined, max: 500 }
    }
  });
  const { gateway, ccxt } = makeGateway('okx', [constrained]);

  await assert.rejects(
    gateway.createOrder(spotRequest()),
    isNoOrderSubmitted
  );
  assert.equal(ccxt.createCalls.length, 0);
});

test('blocks a constrained market order when no usable quote is available', async () => {
  const constrained = okxSpotMarket({
    limits: {
      amount: { min: 0.000001, max: undefined },
      price: { min: undefined, max: undefined },
      cost: { min: 1, max: undefined }
    }
  });
  const { gateway, ccxt } = makeGateway('okx', [constrained]);
  ccxt.ticker = {};

  await assert.rejects(
    gateway.createOrder(spotMarketRequest('sell')),
    isNoOrderSubmitted
  );
  assert.equal(ccxt.createCalls.length, 0);
});

test('Bitget spot market buy uses a fresh ask as conversion price', async () => {
  const { gateway, ccxt } = makeGateway('bitget');
  ccxt.ticker = { ask: '60001.19', last: '60000' };
  ccxt.pricePrecisionResult = '60001.1';
  ccxt.createResult = ccxtOrder({
    symbol: 'BTC/USDT',
    type: 'market',
    side: 'buy',
    amount: 0.01,
    filled: 0,
    remaining: 0.01,
    average: undefined,
    status: 'open'
  });

  const snapshot = await gateway.createOrder({
    symbol: 'BTC/USDT',
    kind: 'spot',
    type: 'market',
    side: 'buy',
    baseQuantity: '0.01',
    clientOrderId: 'clientorderid0000000000000000001'
  });

  assert.equal(ccxt.createCalls[0]?.amount, '0.01');
  assert.equal(ccxt.createCalls[0]?.price, '60001.1');
  assert.equal(snapshot.averagePrice, null);
  assert.deepEqual(ccxt.events.slice(-4), [
    'amountToPrecision:BTC/USDT:0.01',
    'fetchTicker:BTC/USDT',
    'priceToPrecision:BTC/USDT:60001.19',
    'createOrder:BTC/USDT'
  ]);
});

test('Bitget spot market buy falls back to last when ask is unavailable', async () => {
  const { gateway, ccxt } = makeGateway('bitget');
  ccxt.ticker = { last: 59999 };
  ccxt.createResult = ccxtOrder({
    type: 'market',
    amount: 0.01,
    remaining: 0.01
  });

  await gateway.createOrder({
    symbol: 'BTC/USDT',
    kind: 'spot',
    type: 'market',
    side: 'buy',
    baseQuantity: '0.01',
    clientOrderId: 'clientorderid0000000000000000001'
  });

  assert.equal(ccxt.createCalls[0]?.price, '59999');
});

for (const ticker of [
  {},
  { ask: 0, last: -1 },
  { ask: Number.NaN, last: Number.POSITIVE_INFINITY }
]) {
  test('Bitget blocks a spot market buy without a finite positive reference price', async () => {
    const { gateway, ccxt } = makeGateway('bitget');
    ccxt.ticker = ticker;

    await assert.rejects(
      gateway.createOrder({
        symbol: 'BTC/USDT',
        kind: 'spot',
        type: 'market',
        side: 'buy',
        baseQuantity: '0.01',
        clientOrderId: 'clientorderid0000000000000000001'
      }),
      isNoOrderSubmitted
    );
    assert.equal(ccxt.createCalls.length, 0);
  });
}

test('normalizes open and closed order lists with the same identity and unit rules', async () => {
  const { gateway, ccxt } = makeGateway('okx');
  ccxt.openOrders = [ccxtOrder({
    symbol: 'BTC/USDT:USDT',
    side: 'sell',
    amount: 10,
    filled: 1,
    remaining: 9
  })];
  ccxt.closedOrders = [ccxtOrder({
    id: 'exchange-order-2',
    clientOrderId: 'clientorderid0000000000000000002',
    symbol: 'BTC/USDT:USDT',
    side: 'sell',
    amount: 10,
    filled: 10,
    remaining: 0,
    average: 60000,
    status: 'closed'
  })];

  const [open] = await gateway.fetchOpenOrders('BTC/USDT', 'swap');
  const [closed] = await gateway.fetchClosedOrders('BTC/USDT', 'swap');

  assert.equal(open?.filledBaseQuantity, '0.001');
  assert.equal(open?.remainingBaseQuantity, '0.009');
  assert.equal(closed?.exchangeOrderId, 'exchange-order-2');
  assert.equal(closed?.filledBaseQuantity, '0.01');
  assert.equal(closed?.remainingBaseQuantity, '0');
  assert.equal(closed?.status, 'closed');
});

test('malformed client-id lookup responses are propagated instead of treated as missing', async () => {
  const { gateway, ccxt } = makeGateway('bitget');
  ccxt.fetchOrderResult = ccxtOrder({ id: undefined });

  await assert.rejects(
    gateway.findOrderByClientId(
      'clientorderid0000000000000000001',
      'BTC/USDT',
      'spot'
    ),
    /missing exchange order id/
  );
});

test('rejects inconsistent normalized order arithmetic', async () => {
  const { gateway, ccxt } = makeGateway('okx');
  ccxt.fetchOrderResult = ccxtOrder({
    amount: 0.01,
    filled: 0.004,
    remaining: 0.007
  });

  await assert.rejects(
    gateway.fetchOrder('exchange-order-1', 'BTC/USDT', 'spot'),
    /inconsistent order quantities/
  );
});

for (const [exchangeId, kind, expectedParams] of [
  ['bitget', 'spot', { type: 'spot' }],
  ['bitget', 'swap', {
    type: 'swap',
    productType: 'USDT-FUTURES'
  }],
  ['okx', 'spot', { type: 'spot' }],
  ['okx', 'swap', { type: 'swap' }]
] as const) {
  test(`${exchangeId} explicitly routes ${kind} free balance`, async () => {
    const { gateway, ccxt } = makeGateway(exchangeId);

    assert.equal(await gateway.fetchFreeBalance('USDT', kind), '1234.5');
    assert.deepEqual(ccxt.balanceCalls, [expectedParams]);
  });
}

test('fetches last price as a finite positive decimal string', async () => {
  const { gateway } = makeGateway('bitget');
  assert.equal(await gateway.fetchLastPrice('BTC/USDT', 'spot'), '60000');
});

test('reads Bitget margin, position mode, and short leverage without changing them', async () => {
  const { gateway, ccxt } = makeGateway('bitget');
  ccxt.leverage = {
    info: {
      marginMode: 'isolated',
      posMode: 'hedge_mode'
    },
    symbol: 'BTC/USDT:USDT',
    marginMode: 'isolated',
    longLeverage: 2,
    shortLeverage: 3
  };

  assert.deepEqual(await gateway.fetchAccountSettings('BTC/USDT'), {
    marginMode: 'isolated',
    positionMode: 'hedged',
    leverage: '3'
  });
  assert.deepEqual(ccxt.events.slice(-2), [
    'loadMarkets',
    'fetchLeverage:BTC/USDT:USDT'
  ]);
});

test('reads OKX position mode and an existing short position without changing them', async () => {
  const { gateway, ccxt } = makeGateway('okx');
  ccxt.positionMode = {
    info: { posMode: 'long_short_mode' },
    hedged: true
  };
  ccxt.positions = [{
    symbol: 'BTC/USDT:USDT',
    side: 'short',
    contracts: 4,
    contractSize: 0.001,
    marginMode: 'cross',
    hedged: true,
    leverage: 5,
    info: {}
  }];

  assert.deepEqual(await gateway.fetchAccountSettings('BTC/USDT'), {
    marginMode: 'cross',
    positionMode: 'hedged',
    leverage: '5'
  });
  assert.equal(
    ccxt.events.some((event) => event.startsWith('set')),
    false
  );
});

test('keeps a flat OKX hedged account fail-closed without inventing margin mode or leverage', async () => {
  const { gateway, ccxt } = makeGateway('okx');
  ccxt.positionMode = {
    info: { posMode: 'long_short_mode' },
    hedged: true
  };
  ccxt.positions = [];

  assert.deepEqual(await gateway.fetchAccountSettings('BTC/USDT'), {
    marginMode: 'unknown',
    positionMode: 'hedged',
    leverage: null
  });
  assert.equal(
    ccxt.events.some((event) => event.startsWith('fetchLeverage:')),
    false
  );
  assert.deepEqual(ccxt.setMarginModeCalls, []);
});

test('keeps a flat OKX zero-contract short row fail-closed', async () => {
  const { gateway, ccxt } = makeGateway('okx');
  ccxt.positionMode = {
    info: { posMode: 'long_short_mode' },
    hedged: true
  };
  ccxt.positions = [{
    symbol: 'BTC/USDT:USDT',
    side: 'short',
    contracts: 0,
    contractSize: 0.001,
    marginMode: 'cross',
    hedged: true,
    leverage: 5,
    info: {}
  }];

  assert.deepEqual(await gateway.fetchAccountSettings('BTC/USDT'), {
    marginMode: 'unknown',
    positionMode: 'hedged',
    leverage: null
  });
});

test('uses the OKX short-side settings when hedged sides differ', async () => {
  const { gateway, ccxt } = makeGateway('okx');
  ccxt.positionMode = {
    info: { posMode: 'long_short_mode' },
    hedged: true
  };
  ccxt.positions = [{
    symbol: 'BTC/USDT:USDT',
    side: 'long',
    contracts: 2,
    marginMode: 'cross',
    leverage: 3,
    info: {}
  }, {
    symbol: 'BTC/USDT:USDT',
    side: 'short',
    contracts: 1,
    marginMode: 'isolated',
    leverage: 5,
    info: {}
  }];

  assert.deepEqual(await gateway.fetchAccountSettings('BTC/USDT'), {
    marginMode: 'isolated',
    positionMode: 'hedged',
    leverage: '5'
  });
});

test('registry exposes only configured Bitget and OKX gateways', () => {
  const bitget = makeGateway('bitget').gateway;
  const okx = makeGateway('okx').gateway;
  const registry = new ExchangeRegistry(new Map([
    ['okx', okx],
    ['bitget', bitget]
  ]));

  assert.equal(registry.get('bitget'), bitget);
  assert.equal(registry.get('okx'), okx);
  assert.deepEqual(registry.ids(), ['bitget', 'okx']);
  assert.throws(() => registry.get('kraken'), /unsupported exchange: kraken/);
});

test('registry rejects unsupported ids before accepting their gateway', () => {
  let unsupportedGatewayAccessed = false;
  const unsupported = {
    get exchangeId(): string {
      unsupportedGatewayAccessed = true;
      return 'kraken';
    }
  };

  assert.throws(
    () => new ExchangeRegistry(new Map([
      ['kraken', unsupported as never]
    ])),
    /unsupported exchange: kraken/
  );
  assert.equal(unsupportedGatewayAccessed, false);
});

test('registry snapshots its configured gateways against source-map mutation', () => {
  const originalBitget = makeGateway('bitget').gateway;
  const replacementOkx = makeGateway('okx').gateway;
  const configured = new Map<string, typeof originalBitget>([
    ['bitget', originalBitget]
  ]);
  const registry = new ExchangeRegistry(configured);

  configured.set('bitget', replacementOkx);
  configured.set('okx', replacementOkx);
  configured.delete('bitget');

  assert.deepEqual(registry.ids(), ['bitget']);
  assert.equal(registry.get('bitget'), originalBitget);
  assert.throws(
    () => registry.get('okx'),
    /exchange is not configured: okx/
  );
});

test('registry revalidates gateway identity on every get', () => {
  let currentIdentity = 'bitget';
  const gateway = {
    get exchangeId(): string {
      return currentIdentity;
    }
  };
  const registry = new ExchangeRegistry(new Map([
    ['bitget', gateway as never]
  ]));

  currentIdentity = 'okx';
  assert.throws(
    () => registry.get('bitget'),
    /gateway identity mismatch.*bitget/
  );
});

test('gateway rejects an injected adapter whose identity does not match', () => {
  const ccxt = new CcxtDouble('okx');
  assert.throws(
    () => new CcxtExchangeGateway('bitget', ccxt),
    /adapter identity mismatch/
  );
});

test('order snapshot status maps rejected and unknown CCXT statuses without losing identity', async () => {
  const statuses: Array<[string | undefined, OrderSnapshot['status']]> = [
    ['rejected', 'rejected'],
    ['expired', 'unknown'],
    [undefined, 'unknown']
  ];
  for (const [ccxtStatus, normalizedStatus] of statuses) {
    const { gateway, ccxt } = makeGateway('okx');
    ccxt.fetchOrderResult = ccxtOrder({ status: ccxtStatus });
    const snapshot = await gateway.fetchOrder(
      'exchange-order-1',
      'BTC/USDT',
      'spot'
    );
    assert.equal(snapshot.status, normalizedStatus);
    assert.equal(snapshot.exchangeOrderId, 'exchange-order-1');
  }
});

test('derives Bitget spot actual average from execution cost instead of submission conversion price', async () => {
  const { gateway, ccxt } = makeGateway('bitget');
  ccxt.ticker = { ask: '70000', last: '69000' };
  const result = ccxtOrder({
    id: 'spot-market-cost',
    clientOrderId: 'clientorderid0000000000000000001',
    symbol: 'BTC/USDT',
    type: 'market',
    side: 'buy',
    amount: '0.01',
    filled: '0.01',
    remaining: '0',
    average: undefined,
    cost: '600.01234567890123456789',
    status: 'closed'
  });
  result.average = null as never;
  ccxt.createResult = result;

  const request = spotRequest({ type: 'market' });
  delete request.price;
  const snapshot = await gateway.createOrder(request);

  assert.equal(snapshot.averagePrice, '60001.234567890123456789');
  assert.equal(ccxt.createCalls[0]?.price, '70000');
  assert.notEqual(snapshot.averagePrice, ccxt.createCalls[0]?.price);
});

test('derives USDT-linear swap actual average using contract-size-adjusted filled base', async () => {
  const { gateway, ccxt } = makeGateway('okx');
  ccxt.createResult = ccxtOrder({
    id: 'swap-market-cost',
    clientOrderId: 'clientorderid0000000000000000001',
    symbol: 'BTC/USDT:USDT',
    type: 'market',
    side: 'sell',
    amount: '10',
    filled: '4',
    remaining: '6',
    average: undefined,
    cost: '240.004',
    status: 'canceled'
  });

  const request = swapRequest({
    type: 'market',
    positionSide: 'SHORT'
  });
  delete request.price;
  const snapshot = await gateway.createOrder(request);

  assert.equal(snapshot.filledBaseQuantity, '0.004');
  assert.equal(snapshot.averagePrice, '60001');
});

test('derives an exact weighted actual average from complete identity-consistent trades', async () => {
  const { gateway, ccxt } = makeGateway('bitget');
  ccxt.createResult = ccxtOrder({
    id: 'spot-market-trades',
    clientOrderId: 'clientorderid0000000000000000001',
    symbol: 'BTC/USDT',
    type: 'market',
    side: 'buy',
    amount: '0.01',
    filled: '0.01',
    remaining: '0',
    average: undefined,
    cost: undefined,
    trades: [
      {
        order: 'spot-market-trades',
        symbol: 'BTC/USDT',
        side: 'buy',
        amount: '0.004',
        cost: '240.00000000000000000004'
      },
      {
        order: 'spot-market-trades',
        symbol: 'BTC/USDT',
        side: 'buy',
        amount: '0.006',
        cost: '360.01234567890123456786'
      }
    ]
  });

  const request = spotRequest({ type: 'market' });
  delete request.price;
  const snapshot = await gateway.createOrder(request);

  assert.equal(snapshot.averagePrice, '60001.23456789012345679');
});

test('treats zero average as unavailable and derives the actual average from reliable evidence', async (t) => {
  for (const [name, order, expected] of [
    ['cost', {
      average: 0,
      cost: '600.01234567890123456789',
      trades: []
    }, '60001.234567890123456789'],
    ['trades', {
      average: '0',
      cost: undefined,
      trades: [{
        order: 'spot-market-zero-average',
        symbol: 'BTC/USDT',
        side: 'buy',
        amount: '0.01',
        cost: '600.02'
      }]
    }, '60002']
  ] as const) {
    await t.test(name, async () => {
      const { gateway, ccxt } = makeGateway('bitget');
      ccxt.createResult = ccxtOrder({
        id: 'spot-market-zero-average',
        clientOrderId: 'clientorderid0000000000000000001',
        symbol: 'BTC/USDT',
        type: 'market',
        side: 'buy',
        amount: '0.01',
        filled: '0.01',
        remaining: '0',
        status: 'closed',
        ...structuredClone(order),
        trades: [...structuredClone(order.trades)] as unknown[]
      });

      const request = spotRequest({ type: 'market' });
      delete request.price;
      const snapshot = await gateway.createOrder(request);

      assert.equal(snapshot.averagePrice, expected);
    });
  }
});

test('preserves a missing actual average when zero sentinel has no reliable fallback', async () => {
  const { gateway, ccxt } = makeGateway('bitget');
  ccxt.createResult = ccxtOrder({
    symbol: 'BTC/USDT',
    type: 'market',
    side: 'buy',
    amount: '0.01',
    filled: '0.01',
    remaining: '0',
    average: 0,
    cost: undefined,
    trades: [],
    status: 'closed'
  });

  const request = spotRequest({ type: 'market' });
  delete request.price;
  const snapshot = await gateway.createOrder(request);

  assert.equal(snapshot.averagePrice, null);
});

test('rejects negative or non-numeric average instead of falling back', async (t) => {
  for (const average of [-1, 'not-a-decimal'] as const) {
    await t.test(String(average), async () => {
      const { gateway, ccxt } = makeGateway('bitget');
      ccxt.createResult = ccxtOrder({
        symbol: 'BTC/USDT',
        type: 'market',
        side: 'buy',
        amount: '0.01',
        filled: '0.01',
        remaining: '0',
        average,
        cost: '600',
        status: 'closed'
      });

      const request = spotRequest({ type: 'market' });
      delete request.price;
      await assert.rejects(
        gateway.createOrder(request),
        /average price/
      );
    });
  }
});

test('leaves actual average missing for incomplete or identity-mismatched trades', async (t) => {
  for (const [name, trades] of [
    ['incomplete', [{
      order: 'spot-market-trades',
      symbol: 'BTC/USDT',
      side: 'buy',
      amount: '0.009',
      cost: '540'
    }]],
    ['wrong-order', [{
      order: 'different-order',
      symbol: 'BTC/USDT',
      side: 'buy',
      amount: '0.01',
      cost: '600'
    }]],
    ['malformed', [{
      order: 'spot-market-trades',
      symbol: 'BTC/USDT',
      side: 'buy',
      amount: '0.01',
      cost: 'not-a-decimal'
    }]]
  ] as const) {
    await t.test(name, async () => {
      const { gateway, ccxt } = makeGateway('bitget');
      ccxt.createResult = ccxtOrder({
        id: 'spot-market-trades',
        clientOrderId: 'clientorderid0000000000000000001',
        symbol: 'BTC/USDT',
        type: 'market',
        side: 'buy',
        amount: '0.01',
        filled: '0.01',
        remaining: '0',
        average: undefined,
        cost: undefined,
        trades: [...structuredClone(trades)] as unknown[]
      });

      const request = spotRequest({ type: 'market' });
      delete request.price;
      const snapshot = await gateway.createOrder(request);

      assert.equal(snapshot.averagePrice, null);
    });
  }
});

test('loadMarket rejects unsupported market kinds without falling back', async () => {
  const { gateway } = makeGateway('okx');
  await assert.rejects(
    gateway.loadMarket('BTC/USDT', 'future' as MarketKind),
    /unsupported market kind/
  );
});
