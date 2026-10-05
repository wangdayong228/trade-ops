import { isNativeError, isProxy } from 'node:util/types';
import { Decimal } from 'decimal.js';
import type { MarketRules } from '../domain/types.js';
import {
  createTradeOpsError,
  projectTradeOpsError,
  safeFailureCategory,
  withErrorPhase,
  type ErrorPhase,
  type SafeDiagnosticValue,
  type TradeOpsError
} from '../errors/trade-ops-error.js';
import {
  StrategyNotFoundError,
  type StrategyRecord,
  type StrategyRepository
} from '../storage/strategy-repository.js';
import {
  type PreflightInput,
  type PreflightResult,
  type PreflightService
} from './preflight-service.js';
import {
  releaseStrategyOperation,
  tryAcquireStrategyOperation
} from './strategy-operation-owner.js';

const MARKET_IDENTITY_FIELDS = [
  'exchangeId',
  'symbol',
  'marketId',
  'kind',
  'base',
  'quote',
  'active'
] as const;

const MARKET_DECIMAL_FIELDS = [
  'amountStep',
  'contractSize',
  'minBaseAmount',
  'priceStep'
] as const;

const OPTIONAL_MARKET_DECIMAL_FIELDS = [
  'maxBaseAmount',
  'minQuoteNotional',
  'maxQuoteNotional'
] as const;

function trustedFailure(
  error: unknown,
  phase: ErrorPhase
): TradeOpsError | undefined {
  try {
    const trusted = error as TradeOpsError;
    const phased = withErrorPhase(trusted, phase);
    return trusted.detail.phase === phase ? trusted : phased;
  } catch {
    return undefined;
  }
}

function isLegacyStrategyNotFound(error: unknown): boolean {
  try {
    return typeof error === 'object'
      && error !== null
      && !isProxy(error)
      && isNativeError(error)
      && Object.getPrototypeOf(error) === StrategyNotFoundError.prototype;
  } catch {
    return false;
  }
}

function storageFailure(
  error: unknown,
  strategyId: string,
  operation: string,
  options?: ErrorOptions
): TradeOpsError {
  const trusted = trustedFailure(error, 'storage');
  if (trusted !== undefined) {
    if (options === undefined) return trusted;
    const detail = trusted.detail;
    return createTradeOpsError({
      code: detail.code,
      phase: detail.phase,
      subject: detail.subject,
      expected: detail.expected,
      actual: detail.actual,
      occurredAt: detail.occurredAt,
      ...(detail.evidence === undefined ? {} : { evidence: detail.evidence })
    }, undefined, options);
  }
  return createTradeOpsError({
    code: 'STORAGE_OPERATION_FAILED',
    phase: 'storage',
    subject: {
      type: 'database',
      table: 'strategies',
      recordId: strategyId,
      operation
    },
    expected: `successful ${operation}`,
    actual: safeFailureCategory(error)
  }, undefined, options ?? { cause: error });
}

function operationBusy(strategyId: string): TradeOpsError {
  return createTradeOpsError({
    code: 'STRATEGY_OPERATION_BUSY',
    phase: 'confirmation',
    subject: { type: 'strategy', strategyId, field: 'operationLock' },
    expected: 'available',
    actual: 'busy'
  });
}

function strategyNotFound(strategyId: string): TradeOpsError {
  return createTradeOpsError({
    code: 'STRATEGY_NOT_FOUND',
    phase: 'confirmation',
    subject: { type: 'strategy', strategyId },
    expected: 'existing strategy',
    actual: 'missing'
  });
}

function stateMismatch(record: Readonly<StrategyRecord>): TradeOpsError {
  return createTradeOpsError({
    code: 'STRATEGY_STATE_MISMATCH',
    phase: 'confirmation',
    subject: { type: 'strategy', strategyId: record.id, field: 'state' },
    expected: 'PENDING_CONFIRMATION',
    actual: record.state
  });
}

function invalidFailureRecord(record: Readonly<StrategyRecord>): TradeOpsError {
  let actual = 'preflightFailure present';
  if (record.failureCode !== null && record.preflightFailure !== null) {
    actual = 'failureCode and preflightFailure present';
  } else if (record.failureCode !== null) {
    actual = 'failureCode present';
  }
  return createTradeOpsError({
    code: 'STORAGE_RECORD_INVALID',
    phase: 'storage',
    subject: {
      type: 'database',
      table: 'strategies',
      recordId: record.id,
      field: 'failure',
      operation: 'read strategy record'
    },
    expected: 'no stored failure before confirmation',
    actual
  });
}

function invalidOrderRecord(
  strategyId: string,
  orderCount: number
): TradeOpsError {
  return createTradeOpsError({
    code: 'STORAGE_RECORD_INVALID',
    phase: 'storage',
    subject: {
      type: 'database',
      table: 'strategy_orders',
      recordId: strategyId,
      operation: 'read confirmation orders'
    },
    expected: 'no orders before confirmation',
    actual: `${orderCount} order records`
  });
}

function preflightInput(record: Readonly<StrategyRecord>): PreflightInput {
  return {
    spotExchangeId: record.spotExchangeId,
    contractExchangeId: record.contractExchangeId,
    symbol: record.symbol,
    requestedBaseQuantity: record.requestedBaseQuantity,
    mode: record.mode
  };
}

function driftFailure(
  strategyId: string,
  subject: Parameters<typeof createTradeOpsError>[0]['subject'],
  expected: SafeDiagnosticValue,
  actual: SafeDiagnosticValue
): TradeOpsError {
  return createTradeOpsError({
    code: 'PREFLIGHT_INVALIDATED',
    phase: 'confirmation',
    subject,
    expected,
    actual
  });
}

function decimalEquals(expected: string, actual: string): boolean {
  return new Decimal(expected).eq(new Decimal(actual));
}

function marketDrift(
  strategyId: string,
  expected: Readonly<MarketRules>,
  actual: Readonly<MarketRules>
): TradeOpsError | undefined {
  for (const field of MARKET_IDENTITY_FIELDS) {
    if (expected[field] !== actual[field]) {
      return driftFailure(
        strategyId,
        {
          type: 'market',
          exchangeId: expected.exchangeId,
          symbol: expected.symbol,
          kind: expected.kind,
          field
        },
        expected[field],
        actual[field]
      );
    }
  }

  for (const field of MARKET_DECIMAL_FIELDS) {
    if (!decimalEquals(expected[field], actual[field])) {
      return driftFailure(
        strategyId,
        {
          type: 'market',
          exchangeId: expected.exchangeId,
          symbol: expected.symbol,
          kind: expected.kind,
          field
        },
        expected[field],
        actual[field]
      );
    }
  }

  for (const field of OPTIONAL_MARKET_DECIMAL_FIELDS) {
    const expectedValue = expected[field];
    const actualValue = actual[field];
    if (expectedValue === undefined || actualValue === undefined) {
      if (expectedValue !== actualValue) {
        return driftFailure(
          strategyId,
          {
            type: 'market',
            exchangeId: expected.exchangeId,
            symbol: expected.symbol,
            kind: expected.kind,
            field
          },
          expectedValue ?? 'missing',
          actualValue ?? 'missing'
        );
      }
      continue;
    }
    if (!decimalEquals(expectedValue, actualValue)) {
      return driftFailure(
        strategyId,
        {
          type: 'market',
          exchangeId: expected.exchangeId,
          symbol: expected.symbol,
          kind: expected.kind,
          field
        },
        expectedValue,
        actualValue
      );
    }
  }
  return undefined;
}

function confirmationDrift(
  record: Readonly<StrategyRecord>,
  actual: Readonly<PreflightResult>
): TradeOpsError | undefined {
  const initial = record.preflight;
  const spotDrift = marketDrift(
    record.id,
    initial.spotMarket,
    actual.spotMarket
  );
  if (spotDrift !== undefined) {
    return spotDrift;
  }
  const contractDrift = marketDrift(
    record.id,
    initial.contractMarket,
    actual.contractMarket
  );
  if (contractDrift !== undefined) {
    return contractDrift;
  }
  if (!decimalEquals(
    initial.effectiveBaseQuantity,
    actual.effectiveBaseQuantity
  )) {
    return driftFailure(
      record.id,
      {
        type: 'strategy',
        strategyId: record.id,
        field: 'effectiveBaseQuantity'
      },
      initial.effectiveBaseQuantity,
      actual.effectiveBaseQuantity
    );
  }
  if (
    initial.accountSettings.positionMode
    !== actual.accountSettings.positionMode
  ) {
    return driftFailure(
      record.id,
      {
        type: 'account',
        exchangeId: record.contractExchangeId,
        symbol: record.symbol,
        field: 'positionMode'
      },
      initial.accountSettings.positionMode,
      actual.accountSettings.positionMode
    );
  }
  if (initial.accountSettings.marginMode !== actual.accountSettings.marginMode) {
    return driftFailure(
      record.id,
      {
        type: 'account',
        exchangeId: record.contractExchangeId,
        symbol: record.symbol,
        field: 'marginMode'
      },
      initial.accountSettings.marginMode,
      actual.accountSettings.marginMode
    );
  }
  const expectedLeverage = initial.accountSettings.leverage;
  const actualLeverage = actual.accountSettings.leverage;
  if (
    expectedLeverage === null
    || actualLeverage === null
    || !decimalEquals(expectedLeverage, actualLeverage)
  ) {
    if (expectedLeverage !== actualLeverage) {
      return driftFailure(
        record.id,
        {
          type: 'account',
          exchangeId: record.contractExchangeId,
          symbol: record.symbol,
          field: 'leverage'
        },
        expectedLeverage,
        actualLeverage
      );
    }
  }
  return undefined;
}

function unknownRevalidationFailure(
  strategyId: string,
  error: unknown
): TradeOpsError {
  return createTradeOpsError({
    code: 'PREFLIGHT_INVALIDATED',
    phase: 'confirmation',
    subject: { type: 'strategy', strategyId, field: 'preflight' },
    expected: 'successful confirmation preflight',
    actual: safeFailureCategory(error)
  }, undefined, { cause: error });
}

function evidenceProjectionFailure(
  strategyId: string,
  failure: TradeOpsError,
  error: unknown
): TradeOpsError {
  return createTradeOpsError({
    code: 'STORAGE_OPERATION_FAILED',
    phase: 'storage',
    subject: {
      type: 'database',
      table: 'strategies',
      recordId: strategyId,
      operation: 'preflight invalidation evidence projection'
    },
    expected: 'safe preflight failure projection before persistence',
    actual: safeFailureCategory(error)
  }, undefined, {
    cause: new AggregateError([failure, error], 'preflight failure and evidence projection failed')
  });
}

export class ConfirmationService {
  constructor(
    private readonly repository: StrategyRepository,
    private readonly preflight: Pick<PreflightService, 'run'>,
    private readonly secretProvider: () => readonly string[] = () => []
  ) {}

  async confirm(strategyId: string): Promise<void> {
    if (!tryAcquireStrategyOperation(strategyId)) {
      throw operationBusy(strategyId);
    }
    try {
      const record = this.readInitialRecord(strategyId);
      const failure = await this.revalidate(record);
      if (failure !== undefined) {
        this.invalidate(record, failure);
        throw failure;
      }
      this.commitConfirmation(record);
    } finally {
      releaseStrategyOperation(strategyId);
    }
  }

  private readInitialRecord(strategyId: string): StrategyRecord {
    let record: StrategyRecord;
    try {
      record = this.repository.getStrategy(strategyId);
    } catch (error) {
      if (isLegacyStrategyNotFound(error)) {
        throw strategyNotFound(strategyId);
      }
      throw storageFailure(error, strategyId, 'strategy read');
    }
    if (record.state !== 'PENDING_CONFIRMATION') {
      throw stateMismatch(record);
    }
    if (record.failureCode !== null || record.preflightFailure !== null) {
      throw invalidFailureRecord(record);
    }

    let orderCount: number;
    try {
      orderCount = this.repository.listOrders(record.id).length;
    } catch (error) {
      throw storageFailure(error, record.id, 'confirmation order read');
    }
    if (orderCount !== 0) {
      throw invalidOrderRecord(record.id, orderCount);
    }
    return record;
  }

  private async revalidate(
    record: Readonly<StrategyRecord>
  ): Promise<TradeOpsError | undefined> {
    try {
      const current = await this.preflight.run(
        preflightInput(record),
        'confirmation'
      );
      return confirmationDrift(record, current);
    } catch (error) {
      return trustedFailure(error, 'confirmation')
        ?? unknownRevalidationFailure(record.id, error);
    }
  }

  private invalidate(
    record: Readonly<StrategyRecord>,
    failure: TradeOpsError
  ): void {
    let persistedFailure;
    try {
      persistedFailure = projectTradeOpsError(
        failure,
        this.secretProvider(),
        false
      );
    } catch (error) {
      throw evidenceProjectionFailure(record.id, failure, error);
    }
    try {
      this.repository.invalidatePreflight(record, persistedFailure);
    } catch (error) {
      throw storageFailure(
        error,
        record.id,
        'preflight invalidation',
        {
          cause: new AggregateError(
            [failure, error],
            'preflight invalidation and persistence failed'
          )
        }
      );
    }
  }

  private commitConfirmation(record: Readonly<StrategyRecord>): void {
    try {
      this.repository.confirmPreflight(record);
    } catch (error) {
      throw storageFailure(error, record.id, 'preflight confirmation');
    }
  }
}
