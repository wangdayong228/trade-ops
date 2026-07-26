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

function optionalPositive(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  if (typeof value !== 'number' && typeof value !== 'string') {
    throw new Error(`invalid OKX ${field}`);
  }
  try {
    const parsed = decimal(String(value));
    if (!parsed.isFinite() || parsed.lte(0)) {
      throw new Error(`invalid OKX ${field}`);
    }
    return parsed.toFixed();
  } catch {
    throw new Error(`invalid OKX ${field}`);
  }
}

function positionMarginMode(
  position: Record<string, unknown>
): AccountSettings['marginMode'] {
  if (position.marginMode === 'cross') {
    return 'cross';
  }
  if (position.marginMode === 'isolated') {
    return 'isolated';
  }
  return 'unknown';
}

function oneValue<T>(
  values: readonly T[],
  field: string
): T | undefined {
  const distinct = [...new Set(values)];
  if (distinct.length > 1) {
    throw new Error(`conflicting account settings for OKX ${field}`);
  }
  return distinct[0];
}

export class OkxProfile implements ExchangeProfile {
  readonly exchangeId = 'okx';

  buildCreateOrderParams(request: OrderRequest): Record<string, unknown> {
    const params = buildCreateOrderParams(request);
    if (request.type === 'limit' && request.timeInForce === 'GTC') {
      delete params.timeInForce;
    }
    if (request.kind === 'swap') {
      params.positionSide = request.positionSide === 'SHORT'
        ? 'short'
        : 'net';
    }
    return params;
  }

  async prepareSubmissionPrice(
    _request: OrderRequest,
    _exchange: CcxtExchangeLike,
    _exchangeSymbol: string,
    formattedPrice: string | undefined
  ): Promise<string | undefined> {
    return formattedPrice;
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
    const [mode, positions] = await Promise.all([
      exchange.fetchPositionMode(exchangeSymbol),
      exchange.fetchPositions([exchangeSymbol])
    ]);
    const shortPositions = positions.filter(
      (position) => position.side === 'short'
    );
    const relevantPositions = mode.hedged === true
      ? shortPositions
      : positions;
    const marginModes = relevantPositions
      .map(positionMarginMode)
      .filter((value) => value !== 'unknown');
    const leverages = relevantPositions
      .map((position) => optionalPositive(position.leverage, 'leverage'))
      .filter((value): value is string => value !== null);
    const marginMode = oneValue(marginModes, 'margin mode') ?? 'unknown';
    const leverage = oneValue(leverages, 'leverage') ?? null;

    let positionMode: AccountSettings['positionMode'] = 'unknown';
    if (mode.hedged === true) {
      positionMode = 'hedged';
    } else if (mode.hedged === false) {
      positionMode = 'one-way';
    }

    return { marginMode, positionMode, leverage };
  }
}
