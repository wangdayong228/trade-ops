/// <reference types="node" />

import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import test from 'node:test';
import type { Logger } from 'pino';
import type { OrderSnapshot } from '../../src/domain/types.js';
import type { StrategyOrderRecord } from '../../src/storage/strategy-repository.js';
import { createAppLogger } from '../../src/logging/logger.js';
import {
  NOOP_TRADE_EVENT_SINK,
  PinoTradeEventSink,
  orderEvent,
  type TradeEvent
} from '../../src/logging/trade-events.js';

function captureDestination(output: string[]): Writable {
  return new Writable({
    write(chunk, _encoding, callback) {
      output.push(String(chunk));
      callback();
    }
  });
}

const SNAPSHOT: OrderSnapshot = {
  exchangeId: 'bitget',
  exchangeOrderId: 'exchange-order-1',
  clientOrderId: 'tradeops-strategy-1-spot-market',
  symbol: 'BTC/USDT',
  kind: 'spot',
  type: 'limit',
  side: 'buy',
  requestedBaseQuantity: '1.25',
  filledBaseQuantity: '0.75',
  remainingBaseQuantity: '0.50',
  averagePrice: '65000.25',
  status: 'open',
  updatedAt: '2026-08-01T00:00:01.000Z'
};

const ORDER: StrategyOrderRecord = {
  id: 'strategy-order-1',
  strategyId: 'strategy-1',
  role: 'SPOT_HEDGE_GTC',
  exchangeId: 'bitget',
  clientOrderId: SNAPSHOT.clientOrderId,
  exchangeOrderId: SNAPSHOT.exchangeOrderId,
  request: {
    symbol: 'BTC/USDT',
    kind: 'spot',
    type: 'limit',
    side: 'buy',
    baseQuantity: '1.25',
    price: '64999.50',
    timeInForce: 'GTC',
    clientOrderId: SNAPSHOT.clientOrderId,
    marginMode: 'isolated'
  },
  snapshot: SNAPSHOT,
  status: 'open',
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:01.000Z'
};

test('order and Pino adapters apply independent runtime allowlists', () => {
  const output: string[] = [];
  const logger = createAppLogger(captureDestination(output));
  const sink = new PinoTradeEventSink(logger.child({ component: 'trade' }));
  const unsafeOrder = Object.assign({}, ORDER, {
    apiKey: 'FORBIDDEN-API-KEY',
    secret: 'FORBIDDEN-SECRET',
    rawRequest: { password: 'FORBIDDEN-PASSWORD' },
    rawResponse: { authorization: 'FORBIDDEN-AUTH' }
  }) as StrategyOrderRecord;
  const event = Object.assign(orderEvent(
    'order_status_changed',
    unsafeOrder,
    SNAPSHOT,
    {
      mode: 'CONCURRENT',
      strategyState: 'EXECUTING',
      failureCode: 'ORDER_SUBMISSION_UNKNOWN',
      errorType: 'NetworkError',
      errorCode: 'ETIMEDOUT'
    }
  ), {
    apiKey: 'SECOND-ALLOWLIST-API-KEY',
    rawResponse: { body: 'SECOND-ALLOWLIST-RESPONSE' }
  }) as TradeEvent;

  sink.record(event);

  const line = JSON.parse(output.join('').trim()) as Record<string, unknown>;
  assert.deepEqual({
    event: line.event,
    strategyId: line.strategyId,
    mode: line.mode,
    strategyState: line.strategyState,
    role: line.role,
    exchangeId: line.exchangeId,
    symbol: line.symbol,
    kind: line.kind,
    type: line.type,
    side: line.side,
    clientOrderId: line.clientOrderId,
    exchangeOrderId: line.exchangeOrderId,
    requestedBaseQuantity: line.requestedBaseQuantity,
    filledBaseQuantity: line.filledBaseQuantity,
    remainingBaseQuantity: line.remainingBaseQuantity,
    price: line.price,
    averagePrice: line.averagePrice,
    timeInForce: line.timeInForce,
    marginMode: line.marginMode,
    status: line.status,
    failureCode: line.failureCode,
    errorType: line.errorType,
    errorCode: line.errorCode
  }, {
    event: 'order_status_changed',
    strategyId: 'strategy-1',
    mode: 'CONCURRENT',
    strategyState: 'EXECUTING',
    role: 'SPOT_HEDGE_GTC',
    exchangeId: 'bitget',
    symbol: 'BTC/USDT',
    kind: 'spot',
    type: 'limit',
    side: 'buy',
    clientOrderId: 'tradeops-strategy-1-spot-market',
    exchangeOrderId: 'exchange-order-1',
    requestedBaseQuantity: '1.25',
    filledBaseQuantity: '0.75',
    remainingBaseQuantity: '0.50',
    price: '64999.50',
    averagePrice: '65000.25',
    timeInForce: 'GTC',
    marginMode: 'isolated',
    status: 'open',
    failureCode: 'ORDER_SUBMISSION_UNKNOWN',
    errorType: 'NetworkError',
    errorCode: 'ETIMEDOUT'
  });
  assert.doesNotMatch(
    JSON.stringify(line),
    /apiKey|secret|password|authorization|rawRequest|rawResponse|FORBIDDEN|SECOND-ALLOWLIST/
  );
});

test('supports contract position fields without adding unrelated fields', () => {
  const contractOrder: StrategyOrderRecord = {
    ...ORDER,
    role: 'CONTRACT_MARKET',
    exchangeId: 'okx',
    clientOrderId: 'tradeops-strategy-1-contract-market',
    request: {
      symbol: 'BTC/USDT',
      kind: 'swap',
      type: 'market',
      side: 'sell',
      baseQuantity: '1',
      clientOrderId: 'tradeops-strategy-1-contract-market',
      positionSide: 'SHORT',
      marginMode: 'cross'
    },
    snapshot: null,
    exchangeOrderId: null,
    status: 'planned'
  };

  assert.deepEqual(orderEvent('order_planned', contractOrder), {
    event: 'order_planned',
    strategyId: 'strategy-1',
    role: 'CONTRACT_MARKET',
    exchangeId: 'okx',
    symbol: 'BTC/USDT',
    kind: 'swap',
    type: 'market',
    side: 'sell',
    clientOrderId: 'tradeops-strategy-1-contract-market',
    requestedBaseQuantity: '1',
    positionSide: 'SHORT',
    marginMode: 'cross',
    status: 'planned'
  });
});

test('trade logging failures and the no-op sink never propagate', () => {
  const logger = {
    info(): never {
      throw new Error('stdout unavailable');
    }
  } as unknown as Logger;
  const event = orderEvent('order_planned', ORDER);

  assert.doesNotThrow(() => new PinoTradeEventSink(logger).record(event));
  assert.doesNotThrow(() => NOOP_TRADE_EVENT_SINK.record(event));
  assert.equal(Object.isFrozen(NOOP_TRADE_EVENT_SINK), true);
});

test('Pino trade output replaces credential values inside error classifications', () => {
  const output: string[] = [];
  const logger = createAppLogger(captureDestination(output));
  const sink = new PinoTradeEventSink(
    logger,
    () => ['credential-value']
  );
  const event = orderEvent('order_submit_uncertain', ORDER, null, {
    failureCode: 'ORDER_SUBMISSION_UNKNOWN',
    errorType: 'ExchangeError-credential-value',
    errorCode: 'credential-value'
  });

  sink.record(event);

  const line = output.join('');
  assert.doesNotMatch(line, /credential-value/);
  assert.match(line, /\[Redacted\]/);
});

test('Pino trade output replaces credential values in every allowlisted field', () => {
  const output: string[] = [];
  const logger = createAppLogger(captureDestination(output));
  const sink = new PinoTradeEventSink(
    logger,
    () => ['credential-value']
  );
  const event = {
    ...orderEvent('order_status_changed', ORDER, SNAPSHOT),
    strategyId: 'strategy-credential-value',
    symbol: 'credential-value/USDT',
    clientOrderId: 'client-credential-value',
    exchangeOrderId: 'exchange-credential-value'
  };

  sink.record(event);

  const line = output.join('');
  assert.doesNotMatch(line, /credential-value/);
  assert.match(line, /\[Redacted\]/);
});
