import { decimal } from '../../domain/decimal.js';
import type {
  AccountSettings,
  OrderRequest
} from '../../domain/types.js';
import {
  createTradeOpsError,
  type SafeDiagnosticValue
} from '../../errors/trade-ops-error.js';
import type {
  CcxtExchangeLike
} from '../ccxt-exchange-gateway.js';
import {
  buildCreateOrderParams,
  type ExchangeProfile
} from '../exchange-profile.js';

function safeLeverageActual(value: unknown): SafeDiagnosticValue {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(value) : 'non-finite number';
  }
  if (typeof value === 'string') {
    const text = value.trim();
    if (text === '') {
      return 'empty string';
    }
    try {
      const parsed = decimal(text);
      return parsed.isFinite()
        ? parsed.toFixed()
        : 'non-finite decimal string';
    } catch {
      return 'malformed decimal string';
    }
  }
  return `${typeof value} value`;
}

function invalidLeverage(
  exchangeSymbol: string,
  value: unknown
): never {
  throw createTradeOpsError({
    code: 'ACCOUNT_LEVERAGE_MISMATCH',
    phase: 'preflight',
    subject: {
      type: 'account',
      exchangeId: 'okx',
      symbol: exchangeSymbol,
      field: 'leverage'
    },
    expected: 'finite decimal greater than zero',
    actual: safeLeverageActual(value)
  });
}

function optionalPositive(
  value: unknown,
  exchangeSymbol: string
): string | null {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  if (typeof value !== 'number' && typeof value !== 'string') {
    return invalidLeverage(exchangeSymbol, value);
  }
  let parsed: ReturnType<typeof decimal>;
  try {
    parsed = decimal(String(value));
  } catch {
    return invalidLeverage(exchangeSymbol, value);
  }
  return !parsed.isFinite() || parsed.lte(0)
    ? invalidLeverage(exchangeSymbol, value)
    : parsed.toFixed();
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

function isOpenPosition(
  position: Record<string, unknown>,
  exchangeSymbol: string
): boolean {
  if (position.symbol !== exchangeSymbol) {
    return false;
  }
  const { contracts } = position;
  if (
    (typeof contracts !== 'number' && typeof contracts !== 'string')
    || contracts === ''
  ) {
    return false;
  }
  try {
    const parsed = decimal(String(contracts));
    return parsed.isFinite() && parsed.gt(0);
  } catch {
    return false;
  }
}

function oneValue<T>(
  values: readonly T[],
  field: 'marginMode' | 'leverage',
  exchangeSymbol: string,
  expected: string
): T | undefined {
  const distinct = [...new Set(values)];
  if (distinct.length > 1) {
    throw createTradeOpsError({
      code: 'ACCOUNT_SETTINGS_CONFLICT',
      phase: 'preflight',
      subject: {
        type: 'account',
        exchangeId: 'okx',
        symbol: exchangeSymbol,
        field
      },
      expected,
      actual: distinct.map(String)
    });
  }
  return distinct[0];
}

export class OkxProfile implements ExchangeProfile {
  readonly exchangeId = 'okx';

  balanceParams(kind: 'spot' | 'swap'): Record<string, unknown> {
    return { type: kind };
  }

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
    const mode = await exchange.fetchPositionMode(exchangeSymbol);
    let positionMode: AccountSettings['positionMode'] = 'unknown';
    if (mode.hedged === true) {
      positionMode = 'hedged';
    } else if (mode.hedged === false) {
      positionMode = 'one-way';
    }
    if (positionMode !== 'hedged') {
      return {
        marginMode: 'unknown',
        positionMode,
        leverage: null
      };
    }

    const positions = await exchange.fetchPositions([exchangeSymbol]);
    const openPositions = positions.filter((position) => (
      isOpenPosition(position, exchangeSymbol)
    ));
    const shortPositions = openPositions.filter(
      (position) => position.side === 'short'
    );
    const marginModes = shortPositions
      .map(positionMarginMode);
    if (marginModes.includes('unknown')) {
      return {
        marginMode: 'unknown',
        positionMode,
        leverage: null
      };
    }
    const marginMode = oneValue(
      marginModes,
      'marginMode',
      exchangeSymbol,
      'one consistent margin mode'
    ) ?? 'unknown';
    const leverages = shortPositions
      .map((position) => optionalPositive(position.leverage, exchangeSymbol))
      .filter((value): value is string => value !== null);
    const leverage = oneValue(
      leverages,
      'leverage',
      exchangeSymbol,
      'one consistent positive leverage'
    ) ?? null;

    return { marginMode, positionMode, leverage };
  }
}
