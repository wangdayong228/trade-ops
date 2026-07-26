export type MarketKind = 'spot' | 'swap';
export type OrderSide = 'buy' | 'sell';
export type OrderType = 'market' | 'limit';
export type ExecutionMode = 'CONCURRENT' | 'CONTRACT_FIRST' | 'SPOT_FIRST';
export type StrategyState =
  | 'PENDING_CONFIRMATION'
  | 'EXECUTING'
  | 'WAITING_HEDGE'
  | 'HEDGED'
  | 'HEDGE_INCOMPLETE'
  | 'FAILED';
export type OrderRole =
  | 'SPOT_MARKET'
  | 'CONTRACT_MARKET'
  | 'SPOT_HEDGE_GTC'
  | 'CONTRACT_HEDGE_GTC';

export interface MarketRules {
  exchangeId: string;
  symbol: string;
  marketId: string;
  kind: MarketKind;
  base: string;
  quote: 'USDT';
  active: boolean;
  amountStep: string;
  contractSize: string;
  minBaseAmount: string;
  maxBaseAmount?: string;
  priceStep: string;
}

export interface AccountSettings {
  marginMode: 'isolated' | 'cross' | 'unknown';
  positionMode: 'one-way' | 'hedged' | 'unknown';
  leverage: string | null;
}

export interface OrderRequest {
  symbol: string;
  kind: MarketKind;
  type: OrderType;
  side: OrderSide;
  baseQuantity: string;
  price?: string;
  timeInForce?: 'GTC';
  clientOrderId: string;
  positionSide?: 'SHORT';
}

export interface OrderSnapshot {
  exchangeId: string;
  exchangeOrderId: string;
  clientOrderId: string;
  symbol: string;
  kind: MarketKind;
  type: OrderType;
  side: OrderSide;
  requestedBaseQuantity: string;
  filledBaseQuantity: string;
  remainingBaseQuantity: string;
  averagePrice: string | null;
  status: 'open' | 'closed' | 'canceled' | 'rejected' | 'unknown';
  updatedAt: string;
}
