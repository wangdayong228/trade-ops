import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AuthenticationError,
  NetworkError,
  OrderNotFound,
  PermissionDenied,
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
    average: undefined,
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
  readonly openOrderCalls: string[] = [];
  readonly closedOrderCalls: string[] = [];
  amountPrecisionResult: string | undefined;
  pricePrecisionResult: string | undefined;
  ticker: { ask?: number | string; last?: number | string } = {
    ask: 60001,
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

  async fetchBalance(): Promise<Record<string, unknown>> {
    this.events.push('fetchBalance');
    return this.balance;
  }

  async fetchTicker(
    symbol: string
  ): Promise<{ ask?: number | string; last?: number | string }> {
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
    ...overrides
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
      priceStep: '0.1'
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

test('Bitget creates a one-way opening short with explicit GTC mapping', async () => {
  const { gateway, ccxt } = makeGateway('bitget');
  ccxt.createResult = ccxtOrder({
    symbol: 'BTC/USDT:USDT',
    type: 'limit',
    side: 'sell',
    amount: 0.01,
    filled: 0,
    remaining: 0.01
  });

  await gateway.createOrder(swapRequest());

  assert.deepEqual(ccxt.createCalls[0], {
    symbol: 'BTC/USDT:USDT',
    type: 'limit',
    side: 'sell',
    amount: '0.01',
    price: '60000',
    params: {
      clientOrderId: 'clientorderid0000000000000000001',
      timeInForce: 'GTC',
      reduceOnly: false,
      oneWayMode: true
    }
  });
});

test('Bitget creates a hedged opening short through the locked hedged profile parameter', async () => {
  const { gateway, ccxt } = makeGateway('bitget');
  ccxt.createResult = ccxtOrder({
    symbol: 'BTC/USDT:USDT',
    type: 'limit',
    side: 'sell',
    amount: 0.01,
    filled: 0,
    remaining: 0.01
  });

  await gateway.createOrder(swapRequest({ positionSide: 'SHORT' }));

  assert.deepEqual(ccxt.createCalls[0]?.params, {
    clientOrderId: 'clientorderid0000000000000000001',
    timeInForce: 'GTC',
    reduceOnly: false,
    hedged: true
  });
});

test('OKX creates a one-way opening short using net position side and regular-limit default GTC', async () => {
  const { gateway, ccxt } = makeGateway('okx');
  ccxt.createResult = ccxtOrder({
    symbol: 'BTC/USDT:USDT',
    type: 'limit',
    side: 'sell',
    amount: 10,
    filled: 0,
    remaining: 10
  });

  await gateway.createOrder(swapRequest());

  assert.deepEqual(ccxt.createCalls[0]?.params, {
    clientOrderId: 'clientorderid0000000000000000001',
    reduceOnly: false,
    positionSide: 'net'
  });
});

test('OKX creates a hedged opening short using lowercase short position side', async () => {
  const { gateway, ccxt } = makeGateway('okx');
  ccxt.createResult = ccxtOrder({
    symbol: 'BTC/USDT:USDT',
    type: 'limit',
    side: 'sell',
    amount: 10,
    filled: 0,
    remaining: 10
  });

  await gateway.createOrder(swapRequest({ positionSide: 'SHORT' }));

  assert.deepEqual(ccxt.createCalls[0]?.params, {
    clientOrderId: 'clientorderid0000000000000000001',
    reduceOnly: false,
    positionSide: 'short'
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
    /amount precision changed/
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
      /finite positive ticker ask or last/
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

test('fetches free USDT balance and last price as finite positive decimal strings', async () => {
  const { gateway } = makeGateway('bitget');

  assert.equal(await gateway.fetchFreeBalance('USDT'), '1234.5');
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

test('uses the OKX short-side settings when hedged sides differ', async () => {
  const { gateway, ccxt } = makeGateway('okx');
  ccxt.positionMode = {
    info: { posMode: 'long_short_mode' },
    hedged: true
  };
  ccxt.positions = [{
    symbol: 'BTC/USDT:USDT',
    side: 'long',
    marginMode: 'cross',
    leverage: 3,
    info: {}
  }, {
    symbol: 'BTC/USDT:USDT',
    side: 'short',
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

test('loadMarket rejects unsupported market kinds without falling back', async () => {
  const { gateway } = makeGateway('okx');
  await assert.rejects(
    gateway.loadMarket('BTC/USDT', 'future' as MarketKind),
    /unsupported market kind/
  );
});
