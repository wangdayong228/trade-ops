/// <reference types="node" />

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  baseToExchangeAmount,
  exchangeAmountToBase
} from '../../src/exchanges/exchange-gateway.js';
import type {
  MarketRules,
  OrderRequest,
  OrderSnapshot
} from '../../src/domain/types.js';
import { FakeExchangeGateway } from '../support/fake-exchange-gateway.js';
import { order } from '../support/order-fixtures.js';

test('converts perpetual contracts to and from base quantity', () => {
  assert.equal(baseToExchangeAmount('0.015', '0.001'), '15');
  assert.equal(exchangeAmountToBase('15', '0.001'), '0.015');
});

test('converts base quantities using different contract sizes', () => {
  assert.equal(baseToExchangeAmount('2.5', '0.1'), '25');
  assert.equal(exchangeAmountToBase('25', '0.1'), '2.5');
  assert.equal(baseToExchangeAmount('0.0003', '0.0001'), '3');
  assert.equal(exchangeAmountToBase('3', '0.0001'), '0.0003');
});

test('serializes large decimal conversions exactly without number arithmetic', () => {
  const baseQuantity = '12345678901234567890.123';
  const contracts = '12345678901234567890123';

  assert.equal(baseToExchangeAmount(baseQuantity, '0.001'), contracts);
  assert.equal(exchangeAmountToBase(contracts, '0.001'), baseQuantity);
});

test('preserves exact serialization beyond the shared Decimal precision', () => {
  const baseQuantity = '12345678901234567890123456789012345678901';
  const contracts = '12345678901234567890123456789012345678901000';

  assert.equal(baseToExchangeAmount(baseQuantity, '0.001'), contracts);
  assert.equal(exchangeAmountToBase(contracts, '0.001'), baseQuantity);
});

test('rejects a base quantity that is not an exact contract count', () => {
  assert.throws(
    () => baseToExchangeAmount('0.0155', '0.001'),
    /whole contract/
  );
});

test('rejects a fractional contract beyond the shared Decimal precision', () => {
  assert.throws(
    () => baseToExchangeAmount(
      '1234567890123456789012345678901234567890.5',
      '1'
    ),
    /whole contract/
  );
});

test('rejects invalid base quantities and contract sizes', () => {
  for (const baseQuantity of ['NaN', 'Infinity', '-Infinity', '0', '-0.001']) {
    assert.throws(
      () => baseToExchangeAmount(baseQuantity, '0.001'),
      /baseQuantity/
    );
  }

  for (const contractSize of ['NaN', 'Infinity', '-Infinity', '0', '-0.001']) {
    assert.throws(
      () => baseToExchangeAmount('1', contractSize),
      /contractSize/
    );
    assert.throws(
      () => exchangeAmountToBase('1', contractSize),
      /contractSize/
    );
  }
});

test('converts zero exchange fill safely and rejects invalid exchange amounts', () => {
  assert.equal(exchangeAmountToBase('0', '0.001'), '0');

  for (const amount of ['NaN', 'Infinity', '-Infinity', '-1']) {
    assert.throws(
      () => exchangeAmountToBase(amount, '0.001'),
      /amount/
    );
  }
});

test('rejects conversion results that overflow or underflow Decimal limits', () => {
  assert.throws(
    () => baseToExchangeAmount(
      '1e5000000000000000',
      '1e-5000000000000000'
    ),
    /contract count/
  );
  assert.throws(
    () => exchangeAmountToBase(
      '1e-5000000000000000',
      '1e-5000000000000000'
    ),
    /base quantity/
  );
});

test('fake gateway returns configured market data, prices, balance, and settings', async () => {
  const gateway = new FakeExchangeGateway('test-exchange');
  const market: MarketRules = {
    exchangeId: 'test-exchange',
    symbol: 'BTC/USDT',
    marketId: 'BTCUSDT',
    kind: 'spot',
    base: 'BTC',
    quote: 'USDT',
    active: true,
    amountStep: '0.0001',
    contractSize: '1',
    minBaseAmount: '0.0001',
    priceStep: '0.1'
  };
  gateway.markets.set('spot:BTC/USDT', market);
  gateway.lastPrices.set('spot:BTC/USDT', '60000.25');
  gateway.quantizedPrices.set('spot:BTC/USDT', '60000.2');
  gateway.freeUsdt = '2500.5';
  gateway.accountSettings = {
    marginMode: 'cross',
    positionMode: 'hedged',
    leverage: '3'
  };

  assert.equal(await gateway.loadMarket('BTC/USDT', 'spot'), market);
  assert.equal(await gateway.fetchLastPrice('BTC/USDT', 'spot'), '60000.25');
  assert.equal(
    await gateway.quantizePrice('BTC/USDT', 'spot', '60000.26'),
    '60000.2'
  );
  assert.equal(
    await gateway.quantizePrice('ETH/USDT', 'spot', '3500.12'),
    '3500.12'
  );
  assert.equal(await gateway.fetchFreeBalance('USDT'), '2500.5');
  assert.deepEqual(
    await gateway.fetchAccountSettings('BTC/USDT'),
    gateway.accountSettings
  );
});

test('fake gateway records creates and consumes create and fetch results in order', async () => {
  const gateway = new FakeExchangeGateway('test-exchange');
  const request = {
    symbol: 'BTC/USDT',
    kind: 'spot' as const,
    type: 'market' as const,
    side: 'buy' as const,
    baseQuantity: '1',
    clientOrderId: 'client-1'
  };
  const created = order({ exchangeOrderId: 'created-1' });
  const fetchedFirst = order({
    exchangeOrderId: 'created-1',
    filledBaseQuantity: '0.4',
    remainingBaseQuantity: '0.6'
  });
  const fetchedSecond = order({
    exchangeOrderId: 'created-1',
    filledBaseQuantity: '1',
    remainingBaseQuantity: '0',
    status: 'closed'
  });
  gateway.createResults.push(created);
  gateway.fetchResults.set('created-1', [fetchedFirst, fetchedSecond]);

  assert.equal(await gateway.createOrder(request), created);
  assert.deepEqual(gateway.createdRequests, [request]);
  assert.equal(
    await gateway.fetchOrder('created-1', 'BTC/USDT', 'spot'),
    fetchedFirst
  );
  assert.equal(
    await gateway.fetchOrder('created-1', 'BTC/USDT', 'spot'),
    fetchedSecond
  );
  assert.equal(
    await gateway.findOrderByClientId('client-1', 'BTC/USDT', 'spot'),
    fetchedSecond
  );
});

test('fake gateway throws descriptive errors for missing required configuration', async () => {
  const gateway = new FakeExchangeGateway('test-exchange');
  const request = {
    symbol: 'BTC/USDT',
    kind: 'spot' as const,
    type: 'market' as const,
    side: 'buy' as const,
    baseQuantity: '1',
    clientOrderId: 'missing-result'
  };

  await assert.rejects(
    gateway.loadMarket('BTC/USDT', 'spot'),
    /missing market.*BTC\/USDT.*spot/
  );
  await assert.rejects(
    gateway.fetchLastPrice('BTC/USDT', 'spot'),
    /missing last price.*BTC\/USDT.*spot/
  );
  await assert.rejects(
    gateway.createOrder(request),
    /missing create result.*missing-result/
  );
  assert.deepEqual(gateway.createdRequests, [request]);
  await assert.rejects(
    gateway.fetchOrder('missing-order', 'BTC/USDT', 'spot'),
    /missing fetch result.*missing-order/
  );
  assert.equal(
    await gateway.findOrderByClientId('unknown-client', 'BTC/USDT', 'spot'),
    null
  );
});

test('fake gateway rejects unsafe create quantities before submission side effects', async () => {
  const validRequest: OrderRequest = {
    symbol: 'BTC/USDT',
    kind: 'spot',
    type: 'market',
    side: 'buy',
    baseQuantity: '1',
    clientOrderId: 'valid-client'
  };

  for (const baseQuantity of ['0', '-1', 'NaN', 'Infinity']) {
    const gateway = new FakeExchangeGateway('test-exchange');
    const created = order({ clientOrderId: validRequest.clientOrderId });
    gateway.createResults.push(created);

    await assert.rejects(
      gateway.createOrder({
        ...validRequest,
        baseQuantity,
        clientOrderId: `invalid-${baseQuantity}`
      }),
      /OrderRequest\.baseQuantity/
    );

    assert.deepEqual(gateway.createdRequests, []);
    assert.equal(
      await gateway.findOrderByClientId(
        `invalid-${baseQuantity}`,
        validRequest.symbol,
        validRequest.kind
      ),
      null
    );
    assert.equal(await gateway.createOrder(validRequest), created);
  }
});

test('fake gateway preserves a complete swap limit short request', async () => {
  const gateway = new FakeExchangeGateway('test-exchange');
  const request: OrderRequest = {
    symbol: 'BTC/USDT',
    kind: 'swap',
    type: 'limit',
    side: 'sell',
    baseQuantity: '0.8',
    price: '61000',
    timeInForce: 'GTC',
    clientOrderId: 'strategy-1:CONTRACT_HEDGE_GTC',
    positionSide: 'SHORT'
  };
  const created = order({
    exchangeOrderId: 'swap-limit-1',
    clientOrderId: request.clientOrderId,
    kind: request.kind,
    type: request.type,
    side: request.side,
    requestedBaseQuantity: request.baseQuantity,
    remainingBaseQuantity: request.baseQuantity
  });
  gateway.createResults.push(created);

  assert.equal(await gateway.createOrder(request), created);
  assert.deepEqual(gateway.createdRequests, [request]);
  assert.equal(
    await gateway.findOrderByClientId(
      request.clientOrderId,
      request.symbol,
      request.kind
    ),
    created
  );
});

test('fake gateway rejects create snapshots that conflict with request identity', async () => {
  const request: OrderRequest = {
    symbol: 'BTC/USDT',
    kind: 'spot',
    type: 'market',
    side: 'buy',
    baseQuantity: '1',
    clientOrderId: 'client-1'
  };
  const mismatches: Array<{
    field: keyof OrderSnapshot;
    overrides: Partial<OrderSnapshot>;
  }> = [
    { field: 'exchangeId', overrides: { exchangeId: 'other-exchange' } },
    { field: 'clientOrderId', overrides: { clientOrderId: 'other-client' } },
    { field: 'symbol', overrides: { symbol: 'ETH/USDT' } },
    { field: 'kind', overrides: { kind: 'swap' } },
    { field: 'type', overrides: { type: 'limit' } },
    { field: 'side', overrides: { side: 'sell' } },
    {
      field: 'requestedBaseQuantity',
      overrides: { requestedBaseQuantity: '2' }
    }
  ];

  for (const { field, overrides } of mismatches) {
    const gateway = new FakeExchangeGateway('test-exchange');
    gateway.createResults.push(order(overrides));

    await assert.rejects(
      gateway.createOrder(request),
      new RegExp(`configured create snapshot.*${field}`)
    );
    assert.equal(
      await gateway.findOrderByClientId(
        request.clientOrderId,
        request.symbol,
        request.kind
      ),
      null
    );
  }
});

test('fake gateway rejects fetch snapshots that conflict with lookup identity', async () => {
  const mismatches: Array<{
    field: 'exchangeId' | 'exchangeOrderId' | 'symbol' | 'kind';
    overrides: Partial<OrderSnapshot>;
  }> = [
    { field: 'exchangeId', overrides: { exchangeId: 'other-exchange' } },
    {
      field: 'exchangeOrderId',
      overrides: { exchangeOrderId: 'other-order' }
    },
    { field: 'symbol', overrides: { symbol: 'ETH/USDT' } },
    { field: 'kind', overrides: { kind: 'swap' } }
  ];

  for (const { field, overrides } of mismatches) {
    const gateway = new FakeExchangeGateway('test-exchange');
    const correct = order({ exchangeOrderId: 'fetch-1' });
    gateway.fetchResults.set('fetch-1', [
      order({ exchangeOrderId: 'fetch-1', ...overrides }),
      correct
    ]);

    await assert.rejects(
      gateway.fetchOrder('fetch-1', 'BTC/USDT', 'spot'),
      new RegExp(`configured fetch snapshot.*${field}`)
    );
    assert.equal(
      await gateway.findOrderByClientId('client-1', 'BTC/USDT', 'spot'),
      null
    );
    assert.equal(
      await gateway.fetchOrder('fetch-1', 'BTC/USDT', 'spot'),
      correct
    );
  }
});

test('fake gateway recovers an exchange-created order after client timeout', async () => {
  const gateway = new FakeExchangeGateway('test-exchange');
  const request: OrderRequest = {
    symbol: 'BTC/USDT',
    kind: 'swap',
    type: 'market',
    side: 'sell',
    baseQuantity: '0.6',
    clientOrderId: 'strategy-1:CONTRACT_MARKET',
    positionSide: 'SHORT'
  };
  const created = order({
    exchangeOrderId: 'contract-market-1',
    clientOrderId: request.clientOrderId,
    kind: request.kind,
    type: request.type,
    side: request.side,
    requestedBaseQuantity: request.baseQuantity,
    filledBaseQuantity: request.baseQuantity,
    remainingBaseQuantity: '0',
    averagePrice: '61000',
    status: 'closed'
  });
  gateway.createResults.push(created);
  gateway.createErrors.set(
    request.clientOrderId,
    new Error('exchange response timed out')
  );

  await assert.rejects(
    gateway.createOrder(request),
    /exchange response timed out/
  );
  assert.deepEqual(gateway.createdRequests, [request]);
  assert.equal(
    await gateway.findOrderByClientId(
      request.clientOrderId,
      request.symbol,
      request.kind
    ),
    created
  );
});

test('fresh fake can seed a validated exchange-observed order for restart recovery', async () => {
  const restarted = new FakeExchangeGateway('test-exchange');
  const observed = order({
    exchangeOrderId: 'spot-gtc-1',
    clientOrderId: 'strategy-1:SPOT_HEDGE_GTC',
    type: 'limit',
    requestedBaseQuantity: '0.6',
    filledBaseQuantity: '0.2',
    remainingBaseQuantity: '0.4',
    averagePrice: '61000'
  });

  restarted.seedObservedOrder(observed);

  assert.equal(
    await restarted.findOrderByClientId(
      observed.clientOrderId,
      observed.symbol,
      observed.kind
    ),
    observed
  );
  assert.equal(
    await restarted.findOrderByClientId(
      observed.clientOrderId,
      'ETH/USDT',
      observed.kind
    ),
    null
  );
  assert.throws(
    () => restarted.seedObservedOrder(order({
      exchangeId: 'other-exchange',
      clientOrderId: 'invalid-seed'
    })),
    /observed snapshot.*exchangeId/
  );
  assert.equal(
    await restarted.findOrderByClientId(
      'invalid-seed',
      'BTC/USDT',
      'spot'
    ),
    null
  );
});
