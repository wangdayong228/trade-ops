import { decimal } from '../../domain/decimal.js';
import type {
  AccountSettings,
  OrderRequest
} from '../../domain/types.js';
import type {
  CcxtExchangeLike
} from '../ccxt-exchange-gateway.js';
import {
  buildCreateOrderParams,
  type ExchangeProfile
} from '../exchange-profile.js';

function finitePositive(value: unknown): string | null {
  if (
    (typeof value !== 'number' && typeof value !== 'string')
    || String(value).trim() === ''
  ) {
    return null;
  }
  try {
    const parsed = decimal(String(value));
    return parsed.isFinite() && parsed.gt(0) ? parsed.toFixed() : null;
  } catch {
    return null;
  }
}

function normalizedMarginMode(value: unknown): AccountSettings['marginMode'] {
  if (value === 'cross' || value === 'crossed') {
    return 'cross';
  }
  if (value === 'isolated') {
    return 'isolated';
  }
  return 'unknown';
}

function normalizedPositionMode(value: unknown): AccountSettings['positionMode'] {
  if (value === 'hedge_mode') {
    return 'hedged';
  }
  if (value === 'one_way_mode') {
    return 'one-way';
  }
  return 'unknown';
}

export class BitgetProfile implements ExchangeProfile {
  readonly exchangeId = 'bitget';

  buildCreateOrderParams(request: OrderRequest): Record<string, unknown> {
    const params = buildCreateOrderParams(request);
    if (request.kind === 'swap') {
      delete params.positionSide;
      if (request.positionSide === 'SHORT') {
        params.hedged = true;
      } else {
        params.oneWayMode = true;
      }
    }
    return params;
  }

  async prepareSubmissionPrice(
    request: OrderRequest,
    exchange: CcxtExchangeLike,
    exchangeSymbol: string,
    formattedPrice: string | undefined
  ): Promise<string | undefined> {
    const needsConversionPrice = request.kind === 'spot'
      && request.type === 'market'
      && request.side === 'buy';
    if (!needsConversionPrice) {
      return formattedPrice;
    }

    const ticker = await exchange.fetchTicker(exchangeSymbol);
    const referencePrice = finitePositive(ticker.ask)
      ?? finitePositive(ticker.last);
    if (referencePrice === null) {
      throw new Error(
        'Bitget spot market buy requires a finite positive ticker ask or last'
      );
    }
    const formatted = exchange.priceToPrecision(
      exchangeSymbol,
      referencePrice as unknown as number
    );
    if (finitePositive(formatted) === null) {
      throw new Error(
        'Bitget spot market buy conversion price is not finite and positive'
      );
    }
    return formatted;
  }

  clientOrderLookupParams(
    clientOrderId: string
  ): Record<string, unknown> {
    return { clientOrderId };
  }

  async fetchAccountSettings(
    exchange: CcxtExchangeLike,
    exchangeSymbol: string
  ): Promise<AccountSettings> {
    const leverage = await exchange.fetchLeverage(exchangeSymbol);
    const info = leverage.info;
    const rawInfo = typeof info === 'object' && info !== null
      ? info as Record<string, unknown>
      : {};
    const rawLeverage = leverage.shortLeverage;
    const parsedLeverage = finitePositive(rawLeverage);

    return {
      marginMode: normalizedMarginMode(
        leverage.marginMode ?? rawInfo.marginMode
      ),
      positionMode: normalizedPositionMode(rawInfo.posMode),
      leverage: parsedLeverage
    };
  }
}
