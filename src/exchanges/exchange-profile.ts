import type {
  AccountSettings,
  OrderRequest
} from '../domain/types.js';
import type {
  CcxtExchangeLike
} from './ccxt-exchange-gateway.js';

export interface ExchangeProfile {
  readonly exchangeId: 'bitget' | 'okx';
  buildCreateOrderParams(request: OrderRequest): Record<string, unknown>;
  prepareSubmissionPrice(
    request: OrderRequest,
    exchange: CcxtExchangeLike,
    exchangeSymbol: string,
    formattedPrice: string | undefined
  ): Promise<string | undefined>;
  clientOrderLookupParams(
    clientOrderId: string
  ): Record<string, unknown>;
  fetchAccountSettings(
    exchange: CcxtExchangeLike,
    exchangeSymbol: string
  ): Promise<AccountSettings>;
}

export function buildCreateOrderParams(
  request: OrderRequest
): Record<string, unknown> {
  const params: Record<string, unknown> = {
    clientOrderId: request.clientOrderId
  };
  if (request.timeInForce !== undefined) {
    params.timeInForce = request.timeInForce;
  }
  if (request.kind === 'swap') {
    params.reduceOnly = false;
  }
  if (request.positionSide !== undefined) {
    params.positionSide = request.positionSide;
  }
  return params;
}
