/// <reference types="node" />

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  baseToExchangeAmount,
  exchangeAmountToBase
} from '../../src/exchanges/exchange-gateway.js';
import type { MarketRules } from '../../src/domain/types.js';
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
