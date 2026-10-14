import { decimal } from '../../domain/decimal.js';
import { diagnosticValue } from '../../errors/error-evidence.js';
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
  accountFieldEvidence,
  accountSettingsEvidence,
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
  value: unknown,
  position: Record<string, unknown>,
  field: 'leverage' | 'shortLeverage',
  options?: ErrorOptions
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
    actual: safeLeverageActual(value),
    evidence: accountSettingsEvidence(
      'okx', exchangeSymbol,
      field === 'leverage' ? '持仓 leverage' : '全仓 shortLeverage',
      '有限正数',
      `${diagnosticValue(value)}; ${accountFieldEvidence(position, field === 'leverage' ? 'info.lever' : 'info.0.lever')}`
    )
  }, undefined, options);
}

function optionalPositive(
  position: Record<string, unknown>,
  exchangeSymbol: string,
  field: 'leverage' | 'shortLeverage' = 'leverage'
): string | null {
  const value = position[field];
  if (value === undefined || value === null || value === '') {
    return null;
  }
  if (typeof value !== 'number' && typeof value !== 'string') {
    return invalidLeverage(exchangeSymbol, value, position, field);
  }
  let parsed: ReturnType<typeof decimal>;
  try {
    parsed = decimal(String(value));
  } catch (error) {
    return invalidLeverage(exchangeSymbol, value, position, field, { cause: error });
  }
  return !parsed.isFinite() || parsed.lte(0)
    ? invalidLeverage(exchangeSymbol, value, position, field)
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

function isOpenPosition(position: Record<string, unknown>): boolean {
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

async function flatCrossSettings(
  exchange: CcxtExchangeLike,
  exchangeSymbol: string,
  exchangeMarketId: string
): Promise<AccountSettings> {
  const response = await exchange.fetchLeverage(exchangeSymbol, {
    marginMode: 'cross'
  });
  if (response.symbol !== exchangeSymbol) {
    throw createTradeOpsError({
      code: 'ACCOUNT_SETTINGS_CONFLICT',
      phase: 'preflight',
      subject: {
        type: 'account', exchangeId: 'okx', symbol: exchangeSymbol, field: 'symbol'
      },
      expected: exchangeSymbol,
      actual: diagnosticValue(response.symbol),
      evidence: accountSettingsEvidence(
        'okx', exchangeSymbol, '全仓杠杆 symbol', exchangeSymbol,
        `${accountFieldEvidence(response, 'symbol')}; ${accountFieldEvidence(response, 'info.0.instId')}`
      )
    });
  }
  // CCXT can substitute the requested symbol for an unknown raw instId.
  const rows = response.info;
  if (!Array.isArray(rows) || rows.length === 0) {
    const actual = Array.isArray(rows) ? 'array length=0' : diagnosticValue(rows);
    throw createTradeOpsError({
      code: 'ACCOUNT_SETTINGS_CONFLICT',
      phase: 'preflight',
      subject: {
        type: 'account', exchangeId: 'okx', symbol: exchangeSymbol, field: 'info'
      },
      expected: `non-empty leverage rows bound to ${exchangeMarketId}`,
      actual,
      evidence: accountSettingsEvidence(
        'okx', exchangeSymbol, '全仓杠杆原始身份', exchangeMarketId,
        `info=${actual}`
      )
    });
  }
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const instId: unknown = typeof row === 'object' && row !== null
      ? row.instId : undefined;
    if (instId !== exchangeMarketId) {
      throw createTradeOpsError({
        code: 'ACCOUNT_SETTINGS_CONFLICT',
        phase: 'preflight',
        subject: {
          type: 'account', exchangeId: 'okx', symbol: exchangeSymbol, field: `info.${index}.instId`
        },
        expected: exchangeMarketId,
        actual: diagnosticValue(instId),
        evidence: accountSettingsEvidence(
          'okx', exchangeSymbol, '全仓杠杆 instId', exchangeMarketId,
          accountFieldEvidence(response, `info.${index}.instId`)
        )
      });
    }
  }
  if (response.marginMode !== 'cross') {
    throw createTradeOpsError({
      code: 'ACCOUNT_MARGIN_MODE_MISMATCH',
      phase: 'preflight',
      subject: {
        type: 'account', exchangeId: 'okx', symbol: exchangeSymbol, field: 'marginMode'
      },
      expected: 'cross',
      actual: diagnosticValue(response.marginMode),
      evidence: accountSettingsEvidence(
        'okx', exchangeSymbol, '全仓杠杆 marginMode', 'cross',
        `${accountFieldEvidence(response, 'marginMode')}; ${accountFieldEvidence(response, 'info.0.mgnMode')}`
      )
    });
  }
  const leverage = optionalPositive(response, exchangeSymbol, 'shortLeverage');
  if (leverage === null) {
    return invalidLeverage(exchangeSymbol, response.shortLeverage, response, 'shortLeverage');
  }
  return { marginMode: 'cross', positionMode: 'hedged', leverage };
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
    exchangeSymbol: string,
    exchangeMarketId: string
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
        leverage: null,
        evidence: accountSettingsEvidence(
          'okx', exchangeSymbol, '持仓模式', 'hedged=true',
          `${accountFieldEvidence(mode, 'hedged')}, ${accountFieldEvidence(mode, 'info.posMode')}`
        )
      };
    }

    const positions = await exchange.fetchPositions([exchangeSymbol]);
    const observedPositions: Array<{
      position: Record<string, unknown>;
      index: number;
    }> = [];
    const matchingPositions = positions.filter((position, index) => {
      observedPositions.push({ position, index });
      return position.symbol === exchangeSymbol;
    });
    const openPositions = matchingPositions.filter(isOpenPosition);
    const shortPositions = openPositions.filter(
      (position) => position.side === 'short'
    );
    if (shortPositions.length === 0) {
      return flatCrossSettings(exchange, exchangeSymbol, exchangeMarketId);
    }
    const marginModes: AccountSettings['marginMode'][] = [];
    for (const position of shortPositions) {
      const mode = positionMarginMode(position);
      if (mode === 'unknown') {
        return {
          marginMode: 'unknown', positionMode, leverage: null,
          evidence: accountSettingsEvidence(
            'okx', exchangeSymbol,
            `positions[${observedPositions.find((row) => row.position === position)?.index}].marginMode`,
            '"isolated" 或 "cross"',
            `${accountFieldEvidence(position, 'marginMode')}; ${accountFieldEvidence(position, 'info.mgnMode')}`
          )
        };
      }
      marginModes.push(mode);
    }
    const marginMode = oneValue(
      marginModes,
      'marginMode',
      exchangeSymbol,
      'one consistent margin mode'
    ) ?? 'unknown';
    const leverages = shortPositions
      .map((position) => optionalPositive(position, exchangeSymbol))
      .filter((value): value is string => value !== null);
    const leverage = oneValue(
      leverages,
      'leverage',
      exchangeSymbol,
      'one consistent positive leverage'
    ) ?? null;

    if (leverage === null) {
      return {
        marginMode, positionMode, leverage,
        evidence: accountSettingsEvidence(
          'okx', exchangeSymbol, '空头杠杆 leverage', '至少一个有限正数',
          shortPositions.map((position) => (
            `positions[${observedPositions.find((row) => row.position === position)?.index}]: ${accountFieldEvidence(position, 'leverage')}; ${accountFieldEvidence(position, 'info.lever')}`
          )).join('; ')
        )
      };
    }
    return { marginMode, positionMode, leverage };
  }
}
