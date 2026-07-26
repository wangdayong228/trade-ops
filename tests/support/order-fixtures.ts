import type { OrderSnapshot } from '../../src/domain/types.js';

export function order(overrides: Partial<OrderSnapshot> = {}): OrderSnapshot {
  return {
    exchangeId: 'test-exchange',
    exchangeOrderId: 'order-1',
    clientOrderId: 'client-1',
    symbol: 'BTC/USDT',
    kind: 'spot',
    type: 'market',
    side: 'buy',
    requestedBaseQuantity: '1',
    filledBaseQuantity: '0',
    remainingBaseQuantity: '1',
    averagePrice: null,
    status: 'open',
    updatedAt: '2026-07-26T00:00:00.000Z',
    ...overrides
  };
}
