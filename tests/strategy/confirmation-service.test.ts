/// <reference types="node" />

import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import {
  createTradeOpsError,
  safeFailureCategory,
  TradeOpsError,
  withErrorPhase,
  type ErrorCode,
  type ErrorDetail,
  type ErrorPhase
} from '../../src/errors/trade-ops-error.js';
import type {
  AccountSettings,
  MarketKind,
  MarketRules,
  OrderRequest,
  OrderRole,
  OrderSnapshot,
  StrategyState
} from '../../src/domain/types.js';
import type {
  LoadedMarketSnapshot,
  MarketLoadOptions
} from '../../src/exchanges/exchange-gateway.js';
import { ExchangeRegistry } from '../../src/exchanges/exchange-registry.js';
import {
  StrategyNotFoundError,
  type OrderSubmissionFailureCode,
  type SnapshotAttachmentResult,
  type StrategyFailureCode,
  type StrategyOrderPlan,
  type StrategyOrderRecord,
  type StrategyRecord,
  type StrategyRepository
} from '../../src/storage/strategy-repository.js';
import {
  PreflightService,
  type PreflightInput,
  type PreflightResult
} from '../../src/strategy/preflight-service.js';
import {
  releaseStrategyOperation,
  tryAcquireStrategyOperation
} from '../../src/strategy/strategy-operation-owner.js';
import { FakeExchangeGateway } from '../support/fake-exchange-gateway.js';

const CONFIRMATION_MODULE_SPECIFIER =
  '../../src/strategy/confirmation-service.js';
const SYMBOL = 'BTC/USDT';
const CREATED_AT = '2026-10-03T00:00:00.000Z';
const NO_ERROR = Symbol('no controlled error');

interface ConfirmationServiceLike {
  confirm(strategyId: string): Promise<void>;
}

type ConfirmationServiceConstructor = new (
  repository: StrategyRepository,
  preflight: Pick<PreflightService, 'run'>
) => ConfirmationServiceLike;

interface ConfirmationModule {
  readonly ConfirmationService: ConfirmationServiceConstructor;
}

async function loadConfirmationModule(): Promise<ConfirmationModule> {
  let candidate: unknown;
  try {
    candidate = await import(CONFIRMATION_MODULE_SPECIFIER);
  } catch (error) {
    assert.fail(
      'Task 4 requires src/strategy/confirmation-service.ts: '
      + `module import failed with ${safeFailureCategory(error)}`
    );
  }
  assert.equal(
    typeof (candidate as Partial<ConfirmationModule>).ConfirmationService,
    'function',
    'Task 4 requires an exported ConfirmationService constructor'
  );
  return candidate as ConfirmationModule;
}

function market(
  exchangeId: 'bitget' | 'okx',
  kind: MarketKind,
  overrides: Partial<MarketRules> = {}
): MarketRules {
  return {
    exchangeId,
    symbol: SYMBOL,
    marketId: kind === 'spot' ? 'BTCUSDT' : 'BTC-USDT-SWAP',
    kind,
    base: 'BTC',
    quote: 'USDT',
    active: true,
    amountStep: kind === 'spot' ? '0.0001' : '1',
    contractSize: kind === 'spot' ? '1' : '0.001',
    minBaseAmount: '0.001',
    maxBaseAmount: '1000',
    minQuoteNotional: '5',
    maxQuoteNotional: '1000000',
    priceStep: '0.1',
    ...overrides
  };
}

function preview(
  overrides: Partial<PreflightResult> = {}
): PreflightResult {
  return {
    spotExchangeId: 'bitget',
    contractExchangeId: 'okx',
    symbol: SYMBOL,
    requestedBaseQuantity: '1',
    effectiveBaseQuantity: '1',
    mode: 'CONCURRENT',
    spotMarket: market('bitget', 'spot'),
    contractMarket: market('okx', 'swap'),
    accountSettings: {
      marginMode: 'cross',
      positionMode: 'hedged',
      leverage: '2'
    },
    spotFreeUsdt: '100000',
    contractFreeUsdt: '50000',
    spotReferencePrice: '60000',
    contractReferencePrice: '60010',
    riskAcknowledgementRequired: true,
    createdAt: CREATED_AT,
    ...overrides
  };
}

function strategy(
  id: string,
  source: PreflightResult = preview(),
  overrides: Partial<StrategyRecord> = {}
): StrategyRecord {
  return {
    id,
    state: 'PENDING_CONFIRMATION',
    mode: source.mode,
    spotExchangeId: source.spotExchangeId,
    contractExchangeId: source.contractExchangeId,
    symbol: source.symbol,
    requestedBaseQuantity: source.requestedBaseQuantity,
    effectiveBaseQuantity: source.effectiveBaseQuantity,
    preflight: structuredClone(source),
    failureCode: null,
    preflightFailure: null,
    createdAt: source.createdAt,
    updatedAt: source.createdAt,
    ...overrides
  };
}

function plannedOrder(strategyId: string): StrategyOrderRecord {
  const request: OrderRequest = {
    symbol: SYMBOL,
    kind: 'spot',
    type: 'market',
    side: 'buy',
    baseQuantity: '1',
    clientOrderId: 'a'.repeat(32)
  };
  return {
    id: 'order-1',
    strategyId,
    role: 'SPOT_MARKET',
    exchangeId: 'bitget',
    clientOrderId: request.clientOrderId,
    exchangeOrderId: null,
    request,
    snapshot: null,
    status: 'planned',
    submissionDisposition: 'SUBMISSION_UNCERTAIN',
    submissionFailureCode: null,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT
  };
}

function forbidden(name: string): never {
  throw new Error(`confirmation service touched forbidden repository method ${name}`);
}

class ControlledRepository implements StrategyRepository {
  readonly calls: string[] = [];
  readonly confirmCalls: Readonly<StrategyRecord>[] = [];
  readonly invalidateCalls: Array<{
    readonly expected: Readonly<StrategyRecord>;
    readonly failure: ErrorDetail;
  }> = [];
  readonly forbiddenCalls: string[] = [];
  orders: StrategyOrderRecord[] = [];
  getError: unknown = NO_ERROR;
  listError: unknown = NO_ERROR;
  confirmError: unknown = NO_ERROR;
  invalidateError: unknown = NO_ERROR;

  constructor(public record: StrategyRecord) {}

  createPending(_preflight: PreflightResult): StrategyRecord {
    this.forbiddenCalls.push('createPending');
    return forbidden('createPending');
  }

  getStrategy(id: string): StrategyRecord {
    this.calls.push('getStrategy');
    if (this.getError !== NO_ERROR) throw this.getError;
    if (id !== this.record.id) throw new StrategyNotFoundError();
    return this.record;
  }

  confirmPreflight(expected: Readonly<StrategyRecord>): void {
    this.calls.push('confirmPreflight');
    this.confirmCalls.push(expected);
    if (this.confirmError !== NO_ERROR) throw this.confirmError;
    this.record = { ...this.record, state: 'EXECUTING' };
  }

  invalidatePreflight(
    expected: Readonly<StrategyRecord>,
    failure: ErrorDetail
  ): void {
    this.calls.push('invalidatePreflight');
    this.invalidateCalls.push({ expected, failure });
    if (this.invalidateError !== NO_ERROR) throw this.invalidateError;
    this.record = {
      ...this.record,
      state: 'PREFLIGHT_INVALIDATED',
      preflightFailure: failure
    };
  }

  claimForExecution(_id: string): boolean {
    this.forbiddenCalls.push('claimForExecution');
    return forbidden('claimForExecution');
  }

  planOrder(
    _strategyId: string,
    _role: OrderRole,
    _request: OrderRequest
  ): StrategyOrderRecord {
    this.forbiddenCalls.push('planOrder');
    return forbidden('planOrder');
  }

  planOrdersAtomically(
    _strategyId: string,
    _plans: readonly Readonly<StrategyOrderPlan>[]
  ): StrategyOrderRecord[] {
    this.forbiddenCalls.push('planOrdersAtomically');
    return forbidden('planOrdersAtomically');
  }

  attachOrderSnapshot(
    _strategyOrderId: string,
    _snapshot: OrderSnapshot
  ): SnapshotAttachmentResult {
    this.forbiddenCalls.push('attachOrderSnapshot');
    return forbidden('attachOrderSnapshot');
  }

  markDefinitelyNotSubmitted(
    _strategyOrderId: string,
    _failureCode: OrderSubmissionFailureCode
  ): boolean {
    this.forbiddenCalls.push('markDefinitelyNotSubmitted');
    return forbidden('markDefinitelyNotSubmitted');
  }

  listOrders(strategyId: string): StrategyOrderRecord[] {
    this.calls.push('listOrders');
    if (this.listError !== NO_ERROR) throw this.listError;
    assert.equal(strategyId, this.record.id);
    return structuredClone(this.orders);
  }

  listOrderEvents(_strategyOrderId: string): OrderSnapshot[] {
    this.forbiddenCalls.push('listOrderEvents');
    return forbidden('listOrderEvents');
  }

  transition(
    _strategyId: string,
    _from: StrategyState[],
    _to: StrategyState,
    _failureCode?: StrategyFailureCode
  ): boolean {
    this.forbiddenCalls.push('transition');
    return forbidden('transition');
  }

  listRecoverable(): StrategyRecord[] {
    this.forbiddenCalls.push('listRecoverable');
    return forbidden('listRecoverable');
  }
}

type PreflightPhase = 'preflight' | 'confirmation';

class ScriptedPreflight implements Pick<PreflightService, 'run'> {
  readonly calls: Array<{
    readonly input: PreflightInput;
    readonly phase: PreflightPhase;
  }> = [];

  constructor(
    private readonly handler: (
      input: PreflightInput,
      phase: PreflightPhase
    ) => PreflightResult | Promise<PreflightResult>
  ) {}

  async run(
    input: PreflightInput,
    phase: PreflightPhase = 'preflight'
  ): Promise<PreflightResult> {
    this.calls.push({ input: structuredClone(input), phase });
    return await this.handler(input, phase);
  }
}

function scriptedResult(result: PreflightResult): ScriptedPreflight {
  return new ScriptedPreflight(() => structuredClone(result));
}

async function captureRejection(operation: Promise<unknown>): Promise<unknown> {
  try {
    await operation;
  } catch (error) {
    return error;
  }
  assert.fail('expected operation to reject');
}

function assertTradeOpsError(
  error: unknown,
  code: ErrorCode,
  phase: ErrorPhase
): asserts error is TradeOpsError {
  let trusted = false;
  try {
    trusted = error instanceof TradeOpsError;
  } catch {
    assert.fail('error identity inspection escaped through a hostile throwable');
  }
  assert.equal(trusted, true, `expected trusted ${code} TradeOpsError`);
  const precise = error as TradeOpsError;
  assert.equal(precise.detail.code, code);
  assert.equal(precise.detail.phase, phase);
  assert.notEqual(precise.detail.expected, null);
  assert.notEqual(precise.detail.actual, null);
  assert.match(precise.detail.message, /检查失败/u);
}

function assertLockAvailable(strategyId: string): void {
  assert.equal(
    tryAcquireStrategyOperation(strategyId),
    true,
    `operation lock for ${strategyId} was not released`
  );
  releaseStrategyOperation(strategyId);
}

function expectedInput(source: PreflightResult): PreflightInput {
  return {
    spotExchangeId: source.spotExchangeId,
    contractExchangeId: source.contractExchangeId,
    symbol: source.symbol,
    requestedBaseQuantity: source.requestedBaseQuantity,
    mode: source.mode
  };
}

function storageFailure(
  strategyId: string,
  code: Extract<ErrorCode,
    'STORAGE_OPERATION_FAILED' | 'STORAGE_TRANSITION_REJECTED'>
): TradeOpsError {
  return createTradeOpsError({
    code,
    phase: 'storage',
    subject: code === 'STORAGE_TRANSITION_REJECTED'
      ? { type: 'strategy', strategyId, field: 'state' }
      : {
          type: 'database',
          table: 'strategies',
          recordId: strategyId,
          operation: 'confirmation transaction'
        },
    expected: 'atomic confirmation transaction',
    actual: 'synthetic-storage-failure'
  });
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolvePromise: ((value: T) => void) | undefined;
  let rejectPromise: ((error: unknown) => void) | undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    resolve(value): void { resolvePromise?.(value); },
    reject(error): void { rejectPromise?.(error); }
  };
}

function changedPreview(
  source: PreflightResult,
  change: (result: PreflightResult) => void
): PreflightResult {
  const result = structuredClone(source);
  change(result);
  return result;
}

test('exports ConfirmationService with the approved async contract', async () => {
  const contract = await loadConfirmationModule();
  assert.equal(typeof contract.ConfirmationService, 'function');
});

test('rejects a busy strategy before reading and does not release another owner lock', async (t) => {
  const { ConfirmationService } = await loadConfirmationModule();
  const strategyId = 'busy-strategy';
  const repository = new ControlledRepository(strategy(strategyId));
  const preflight = scriptedResult(preview());
  assert.equal(tryAcquireStrategyOperation(strategyId), true);
  t.after(() => releaseStrategyOperation(strategyId));
  const service = new ConfirmationService(repository, preflight);

  const error = await captureRejection(service.confirm(strategyId));

  assertTradeOpsError(error, 'STRATEGY_OPERATION_BUSY', 'confirmation');
  assert.deepEqual(error.detail.subject, {
    type: 'strategy', strategyId, field: 'operationLock'
  });
  assert.equal(error.detail.expected, 'available');
  assert.equal(error.detail.actual, 'busy');
  assert.deepEqual(repository.calls, []);
  assert.deepEqual(preflight.calls, []);
  assert.deepEqual(repository.forbiddenCalls, []);
  const acquired = tryAcquireStrategyOperation(strategyId);
  if (acquired) releaseStrategyOperation(strategyId);
  assert.equal(acquired, false, 'busy rejection released another owner lock');
});

test('rejects missing, non-pending, ordered, and failed records before revalidation', async (t) => {
  const { ConfirmationService } = await loadConfirmationModule();
  const cases: Array<{
    readonly name: string;
    readonly configure: (repository: ControlledRepository) => void;
    readonly code: ErrorCode;
    readonly expectedCalls?: readonly string[];
  }> = [
    {
      name: 'missing',
      configure(repository): void {
        repository.getError = new StrategyNotFoundError();
      },
      code: 'STRATEGY_NOT_FOUND',
      expectedCalls: ['getStrategy']
    },
    ...([
      'PREFLIGHT_INVALIDATED',
      'EXECUTING',
      'WAITING_HEDGE',
      'HEDGED',
      'HEDGE_INCOMPLETE',
      'FAILED'
    ] as const).map((state) => ({
      name: state,
      configure(repository: ControlledRepository): void {
        repository.record = { ...repository.record, state };
      },
      code: 'STRATEGY_STATE_MISMATCH' as const,
      expectedCalls: ['getStrategy'] as const
    })),
    {
      name: 'has order',
      configure(repository): void {
        repository.orders = [plannedOrder(repository.record.id)];
      },
      code: 'STORAGE_RECORD_INVALID',
      expectedCalls: ['getStrategy', 'listOrders']
    },
    {
      name: 'has execution failure',
      configure(repository): void {
        repository.record = {
          ...repository.record,
          failureCode: 'ORDER_SUBMISSION_FAILED'
        };
      },
      code: 'STORAGE_RECORD_INVALID'
    },
    {
      name: 'has preflight failure',
      configure(repository): void {
        repository.record = {
          ...repository.record,
          preflightFailure: createTradeOpsError({
            code: 'PREFLIGHT_INVALIDATED',
            phase: 'confirmation',
            subject: {
              type: 'strategy', strategyId: repository.record.id,
              field: 'preflight'
            },
            expected: 'unchanged preflight',
            actual: 'changed preflight'
          }).detail
        };
      },
      code: 'STORAGE_RECORD_INVALID'
    },
    {
      name: 'has both failures',
      configure(repository): void {
        repository.record = {
          ...repository.record,
          failureCode: 'ORDER_SUBMISSION_FAILED',
          preflightFailure: createTradeOpsError({
            code: 'PREFLIGHT_INVALIDATED',
            phase: 'confirmation',
            subject: {
              type: 'strategy', strategyId: repository.record.id,
              field: 'preflight'
            },
            expected: 'unchanged preflight',
            actual: 'changed preflight'
          }).detail
        };
      },
      code: 'STORAGE_RECORD_INVALID'
    }
  ];

  for (const [index, testCase] of cases.entries()) {
    const strategyId = `invalid-initial-${index}`;
    const repository = new ControlledRepository(strategy(strategyId));
    testCase.configure(repository);
    const preflight = scriptedResult(preview());
    const service = new ConfirmationService(repository, preflight);

    const error = await captureRejection(service.confirm(strategyId));

    assertTradeOpsError(
      error,
      testCase.code,
      testCase.code.startsWith('STORAGE_') ? 'storage' : 'confirmation'
    );
    if (testCase.expectedCalls === undefined) {
      assert.equal(repository.calls[0], 'getStrategy', testCase.name);
      assert.equal(
        repository.calls.length === 1
          || (
            repository.calls.length === 2
            && repository.calls[1] === 'listOrders'
          ),
        true,
        `${testCase.name} performed work after the initial integrity check`
      );
    } else {
      assert.deepEqual(repository.calls, testCase.expectedCalls, testCase.name);
    }
    assert.deepEqual(preflight.calls, [], testCase.name);
    assert.deepEqual(repository.confirmCalls, [], testCase.name);
    assert.deepEqual(repository.invalidateCalls, [], testCase.name);
    assert.deepEqual(repository.forbiddenCalls, [], testCase.name);
    assertLockAvailable(strategyId);
  }
  t.after(() => {
    for (let index = 0; index < cases.length; index += 1) {
      releaseStrategyOperation(`invalid-initial-${index}`);
    }
  });
});

test('converts hostile initial read failures without property access or invalidation', async (t) => {
  const { ConfirmationService } = await loadConfirmationModule();
  const secret = 'synthetic-hostile-read-secret';
  let reads = 0;
  const getterObject: Record<string, unknown> = {};
  for (const property of ['name', 'message', 'code']) {
    Object.defineProperty(getterObject, property, {
      enumerable: true,
      get(): never {
        reads += 1;
        throw new Error(secret);
      }
    });
  }
  const revocable = Proxy.revocable({}, {});
  revocable.revoke();

  const cases = [
    { stage: 'get', thrown: getterObject },
    { stage: 'list', thrown: revocable.proxy }
  ] as const;
  for (const [index, testCase] of cases.entries()) {
    const strategyId = `hostile-read-${index}`;
    const repository = new ControlledRepository(strategy(strategyId));
    if (testCase.stage === 'get') {
      repository.getError = testCase.thrown;
    } else {
      repository.listError = testCase.thrown;
    }
    const preflight = scriptedResult(preview());
    const service = new ConfirmationService(repository, preflight);

    const error = await captureRejection(service.confirm(strategyId));

    assertTradeOpsError(error, 'STORAGE_OPERATION_FAILED', 'storage');
    assert.equal(reads, 0);
    assert.equal(JSON.stringify(error.detail).includes(secret), false);
    assert.deepEqual(
      repository.calls,
      testCase.stage === 'get'
        ? ['getStrategy']
        : ['getStrategy', 'listOrders']
    );
    assert.deepEqual(repository.invalidateCalls, []);
    assert.deepEqual(preflight.calls, []);
    assertLockAvailable(strategyId);
  }
  t.after(() => {
    releaseStrategyOperation('hostile-read-0');
    releaseStrategyOperation('hostile-read-1');
  });
});

test('preserves trusted repository read failures without revalidation or invalidation', async (t) => {
  const { ConfirmationService } = await loadConfirmationModule();
  const cases = [
    { stage: 'get', operation: 'read strategy' },
    { stage: 'list', operation: 'list strategy orders' }
  ] as const;

  for (const [index, testCase] of cases.entries()) {
    const strategyId = `trusted-read-${index}`;
    const repository = new ControlledRepository(strategy(strategyId));
    const storedError = createTradeOpsError({
      code: 'STORAGE_OPERATION_FAILED',
      phase: 'storage',
      subject: {
        type: 'database',
        table: 'strategies',
        recordId: strategyId,
        operation: testCase.operation
      },
      expected: 'successful repository read',
      actual: 'synthetic-storage-failure',
      occurredAt: '2026-10-03T00:00:30.000Z'
    });
    if (testCase.stage === 'get') {
      repository.getError = storedError;
    } else {
      repository.listError = storedError;
    }
    const preflight = scriptedResult(preview());
    const service = new ConfirmationService(repository, preflight);

    const error = await captureRejection(service.confirm(strategyId));

    assertTradeOpsError(error, 'STORAGE_OPERATION_FAILED', 'storage');
    assert.deepEqual(error.detail, storedError.detail);
    assert.deepEqual(
      repository.calls,
      testCase.stage === 'get'
        ? ['getStrategy']
        : ['getStrategy', 'listOrders']
    );
    assert.deepEqual(preflight.calls, []);
    assert.deepEqual(repository.confirmCalls, []);
    assert.deepEqual(repository.invalidateCalls, []);
    assert.deepEqual(repository.forbiddenCalls, []);
    assert.equal(repository.record.state, 'PENDING_CONFIRMATION');
    assertLockAvailable(strategyId);
  }
  t.after(() => {
    for (let index = 0; index < cases.length; index += 1) {
      releaseStrategyOperation(`trusted-read-${index}`);
    }
  });
});

test('confirms unchanged rules while allowing fresh prices, balances, and timestamp', async (t) => {
  const { ConfirmationService } = await loadConfirmationModule();
  const original = preview();
  const fresh = preview({
    spotReferencePrice: '60001',
    contractReferencePrice: '60009',
    spotFreeUsdt: '99999',
    contractFreeUsdt: '49999',
    createdAt: '2026-10-03T00:01:00.000Z'
  });
  const strategyId = 'successful-confirmation';
  const initial = strategy(strategyId, original);
  const repository = new ControlledRepository(initial);
  const preflight = scriptedResult(fresh);
  const service = new ConfirmationService(repository, preflight);
  t.after(() => releaseStrategyOperation(strategyId));

  await service.confirm(strategyId);

  assert.deepEqual(preflight.calls, [{
    input: expectedInput(original), phase: 'confirmation'
  }]);
  assert.deepEqual(repository.calls, [
    'getStrategy', 'listOrders', 'confirmPreflight'
  ]);
  assert.equal(repository.confirmCalls.length, 1);
  assert.equal(repository.confirmCalls[0], initial);
  assert.deepEqual(repository.invalidateCalls, []);
  assert.equal(repository.record.state, 'EXECUTING');
  assert.deepEqual(repository.forbiddenCalls, []);
  assertLockAvailable(strategyId);
});

interface DriftCase {
  readonly name: string;
  readonly field: string;
  readonly expected: string | boolean;
  readonly actual: string | boolean;
  readonly change: (result: PreflightResult) => void;
}

const MARKET_DRIFT_CASES: readonly DriftCase[] = [
  ...([
    ['exchangeId', 'bitget', 'other', (value: PreflightResult) => {
      value.spotMarket.exchangeId = 'other';
    }],
    ['symbol', SYMBOL, 'ETH/USDT', (value: PreflightResult) => {
      value.spotMarket.symbol = 'ETH/USDT';
    }],
    ['marketId', 'BTCUSDT', 'BTC-USDT', (value: PreflightResult) => {
      value.spotMarket.marketId = 'BTC-USDT';
    }],
    ['kind', 'spot', 'swap', (value: PreflightResult) => {
      value.spotMarket.kind = 'swap';
    }],
    ['base', 'BTC', 'ETH', (value: PreflightResult) => {
      value.spotMarket.base = 'ETH';
    }],
    ['quote', 'USDT', 'USDC', (value: PreflightResult) => {
      value.spotMarket.quote = 'USDC' as 'USDT';
    }],
    ['active', true, false, (value: PreflightResult) => {
      value.spotMarket.active = false;
    }]
  ] as const).map(([field, expected, actual, change]) => ({
    name: `spot ${field}`, field, expected, actual, change
  })),
  ...([
    ['amountStep', '0.0001', '0.0002'],
    ['contractSize', '1', '2'],
    ['minBaseAmount', '0.001', '0.002'],
    ['maxBaseAmount', '1000', '999'],
    ['priceStep', '0.1', '0.2'],
    ['minQuoteNotional', '5', '6'],
    ['maxQuoteNotional', '1000000', '999999']
  ] as const).map(([field, expected, actual]) => ({
    name: `spot ${field}`,
    field,
    expected,
    actual,
    change(value: PreflightResult): void {
      (value.spotMarket as unknown as Record<string, unknown>)[field] = actual;
    }
  })),
  ...([
    ['exchangeId', 'okx', 'other'],
    ['symbol', SYMBOL, 'ETH/USDT'],
    ['marketId', 'BTC-USDT-SWAP', 'BTC-USDT-FUTURES'],
    ['kind', 'swap', 'spot'],
    ['base', 'BTC', 'ETH'],
    ['quote', 'USDT', 'USDC'],
    ['active', true, false],
    ['amountStep', '1', '2'],
    ['contractSize', '0.001', '0.002'],
    ['minBaseAmount', '0.001', '0.002'],
    ['maxBaseAmount', '1000', '999'],
    ['priceStep', '0.1', '0.2'],
    ['minQuoteNotional', '5', '6'],
    ['maxQuoteNotional', '1000000', '999999']
  ] as const).map(([field, expected, actual]) => ({
    name: `contract ${field}`,
    field,
    expected,
    actual,
    change(value: PreflightResult): void {
      (value.contractMarket as unknown as Record<string, unknown>)[field] = actual;
    }
  })),
  {
    name: 'effectiveBaseQuantity',
    field: 'effectiveBaseQuantity',
    expected: '1',
    actual: '0.9999',
    change(value): void { value.effectiveBaseQuantity = '0.9999'; }
  },
  {
    name: 'positionMode',
    field: 'positionMode',
    expected: 'hedged',
    actual: 'one-way',
    change(value): void { value.accountSettings.positionMode = 'one-way'; }
  },
  {
    name: 'marginMode',
    field: 'marginMode',
    expected: 'cross',
    actual: 'isolated',
    change(value): void { value.accountSettings.marginMode = 'isolated'; }
  },
  {
    name: 'leverage',
    field: 'leverage',
    expected: '2',
    actual: '2.0000000000000000000000000000000000000001',
    change(value): void {
      value.accountSettings.leverage =
        '2.0000000000000000000000000000000000000001';
    }
  }
];

test('invalidates every changed market, quantity, and account field', async (t) => {
  const { ConfirmationService } = await loadConfirmationModule();
  const original = preview();

  for (const [index, testCase] of MARKET_DRIFT_CASES.entries()) {
    const strategyId = `drift-${index}`;
    const repository = new ControlledRepository(strategy(strategyId, original));
    const preflight = scriptedResult(changedPreview(original, testCase.change));
    const service = new ConfirmationService(repository, preflight);

    const error = await captureRejection(service.confirm(strategyId));

    assertTradeOpsError(error, 'PREFLIGHT_INVALIDATED', 'confirmation');
    assert.equal(repository.confirmCalls.length, 0, testCase.name);
    assert.equal(repository.invalidateCalls.length, 1, testCase.name);
    const persisted = repository.invalidateCalls[0]?.failure;
    assert.ok(persisted, testCase.name);
    assert.deepEqual(persisted, error.detail, testCase.name);
    assert.equal(persisted.expected, testCase.expected, testCase.name);
    assert.equal(persisted.actual, testCase.actual, testCase.name);
    assert.equal(
      'field' in persisted.subject ? persisted.subject.field : undefined,
      testCase.field,
      testCase.name
    );
    assert.equal(repository.record.state, 'PREFLIGHT_INVALIDATED');
    assert.deepEqual(repository.forbiddenCalls, []);
    assertLockAvailable(strategyId);
  }
  t.after(() => {
    for (let index = 0; index < MARKET_DRIFT_CASES.length; index += 1) {
      releaseStrategyOperation(`drift-${index}`);
    }
  });
});

test('distinguishes optional market-rule absence from decimal equivalence', async (t) => {
  const { ConfirmationService } = await loadConfirmationModule();
  const optionalFields = [
    'maxBaseAmount', 'minQuoteNotional', 'maxQuoteNotional'
  ] as const;
  let caseIndex = 0;

  for (const marketSide of ['spotMarket', 'contractMarket'] as const) {
    for (const field of optionalFields) {
      for (const direction of ['removed', 'added'] as const) {
        const oldPreview = preview();
        const newPreview = preview();
        if (direction === 'removed') {
          delete newPreview[marketSide][field];
        } else {
          delete oldPreview[marketSide][field];
        }
        const strategyId = `optional-${caseIndex}`;
        caseIndex += 1;
        const repository = new ControlledRepository(
          strategy(strategyId, oldPreview)
        );
        const service = new ConfirmationService(
          repository,
          scriptedResult(newPreview)
        );

        const error = await captureRejection(service.confirm(strategyId));

        assertTradeOpsError(error, 'PREFLIGHT_INVALIDATED', 'confirmation');
        assert.equal(repository.invalidateCalls.length, 1);
        assert.equal(repository.confirmCalls.length, 0);
        assert.equal(
          [error.detail.expected, error.detail.actual].includes('missing'),
          true,
          `${marketSide}.${field} ${direction} did not preserve absence`
        );
        assertLockAvailable(strategyId);
      }
    }
  }
  t.after(() => {
    for (let index = 0; index < caseIndex; index += 1) {
      releaseStrategyOperation(`optional-${index}`);
    }
  });
});

test('accepts decimal-equivalent rules, quantity, and leverage without Number rounding', async (t) => {
  const { ConfirmationService } = await loadConfirmationModule();
  const long = '12345678901234567890123456789012345678901';
  const original = preview({
    requestedBaseQuantity: long,
    effectiveBaseQuantity: long,
    spotMarket: market('bitget', 'spot', {
      amountStep: '0.0001000',
      contractSize: '1.000',
      minBaseAmount: '0.00100',
      maxBaseAmount: `${long}.0`,
      minQuoteNotional: '5.00',
      maxQuoteNotional: '1000000.00',
      priceStep: '0.100'
    }),
    contractMarket: market('okx', 'swap', {
      amountStep: '1.000',
      contractSize: '0.00100',
      minBaseAmount: '0.0010',
      maxBaseAmount: `${long}.00`,
      minQuoteNotional: '5.000',
      maxQuoteNotional: '1e6',
      priceStep: '1e-1'
    }),
    accountSettings: {
      marginMode: 'cross', positionMode: 'hedged', leverage: '2.000'
    }
  });
  const equivalent = preview({
    requestedBaseQuantity: long,
    effectiveBaseQuantity: `${long}.000`,
    spotMarket: market('bitget', 'spot', {
      amountStep: '1e-4',
      contractSize: '1e0',
      minBaseAmount: '1e-3',
      maxBaseAmount: long,
      minQuoteNotional: '5e0',
      maxQuoteNotional: '1e6',
      priceStep: '1e-1'
    }),
    contractMarket: market('okx', 'swap', {
      amountStep: '1e0',
      contractSize: '1e-3',
      minBaseAmount: '0.001',
      maxBaseAmount: long,
      minQuoteNotional: '5',
      maxQuoteNotional: '1000000',
      priceStep: '0.1'
    }),
    accountSettings: {
      marginMode: 'cross', positionMode: 'hedged', leverage: '2e0'
    },
    createdAt: '2026-10-03T00:02:00.000Z'
  });
  const strategyId = 'decimal-equivalence';
  const repository = new ControlledRepository(strategy(strategyId, original));
  const service = new ConfirmationService(
    repository,
    scriptedResult(equivalent)
  );
  t.after(() => releaseStrategyOperation(strategyId));

  await service.confirm(strategyId);

  assert.equal(repository.confirmCalls.length, 1);
  assert.equal(repository.invalidateCalls.length, 0);
  assert.equal(repository.record.state, 'EXECUTING');
  assertLockAvailable(strategyId);
});

test('preserves a precise confirmation failure after invalidation commits', async (t) => {
  const { ConfirmationService } = await loadConfirmationModule();
  const strategyId = 'precise-business-failure';
  const originalFailure = createTradeOpsError({
    code: 'BALANCE_INSUFFICIENT',
    phase: 'preflight',
    subject: {
      type: 'account', exchangeId: 'bitget', symbol: SYMBOL, field: 'balance'
    },
    expected: 'available USDT at least 60000',
    actual: '59999.9999',
    occurredAt: '2026-10-03T00:03:00.000Z'
  });
  const expectedFailure = withErrorPhase(originalFailure, 'confirmation');
  const repository = new ControlledRepository(strategy(strategyId));
  const preflight = new ScriptedPreflight(() => {
    throw originalFailure;
  });
  const service = new ConfirmationService(repository, preflight);
  t.after(() => releaseStrategyOperation(strategyId));

  const error = await captureRejection(service.confirm(strategyId));

  assertTradeOpsError(error, 'BALANCE_INSUFFICIENT', 'confirmation');
  assert.deepEqual(error.detail, expectedFailure.detail);
  assert.equal(repository.invalidateCalls.length, 1);
  assert.deepEqual(
    repository.invalidateCalls[0]?.failure,
    expectedFailure.detail
  );
  assert.equal(repository.record.state, 'PREFLIGHT_INVALIDATED');
  assert.equal(repository.confirmCalls.length, 0);
  assertLockAvailable(strategyId);
});

test('prioritizes storage errors and never converts confirmation writes into invalidation', async (t) => {
  const { ConfirmationService } = await loadConfirmationModule();

  for (const operation of ['invalidate', 'confirm'] as const) {
    for (const code of [
      'STORAGE_OPERATION_FAILED', 'STORAGE_TRANSITION_REJECTED'
    ] as const) {
      const strategyId = `${operation}-${code.toLowerCase()}`;
      const repository = new ControlledRepository(strategy(strategyId));
      const storedError = storageFailure(strategyId, code);
      let preflight: ScriptedPreflight;
      if (operation === 'invalidate') {
        repository.invalidateError = storedError;
        const businessFailure = createTradeOpsError({
          code: 'BALANCE_INSUFFICIENT',
          phase: 'confirmation',
          subject: {
            type: 'account', exchangeId: 'bitget', symbol: SYMBOL,
            field: 'balance'
          },
          expected: 'sufficient balance',
          actual: 'insufficient balance'
        });
        preflight = new ScriptedPreflight(() => {
          throw businessFailure;
        });
      } else {
        repository.confirmError = storedError;
        preflight = scriptedResult(preview());
      }
      const service = new ConfirmationService(repository, preflight);

      const error = await captureRejection(service.confirm(strategyId));

      assertTradeOpsError(error, code, 'storage');
      assert.deepEqual(error.detail, storedError.detail);
      assert.equal(repository.record.state, 'PENDING_CONFIRMATION');
      assert.equal(repository.confirmCalls.length, operation === 'confirm' ? 1 : 0);
      assert.equal(
        repository.invalidateCalls.length,
        operation === 'invalidate' ? 1 : 0,
        `${operation} ${code}`
      );
      assertLockAvailable(strategyId);
    }
  }
  t.after(() => {
    for (const operation of ['invalidate', 'confirm']) {
      for (const code of [
        'storage_operation_failed', 'storage_transition_rejected'
      ]) {
        releaseStrategyOperation(`${operation}-${code}`);
      }
    }
  });
});

test('classifies unknown confirmation write failures without secondary writes', async (t) => {
  const { ConfirmationService } = await loadConfirmationModule();
  const revocable = Proxy.revocable({}, {});
  revocable.revoke();
  const businessFailure = createTradeOpsError({
    code: 'BALANCE_INSUFFICIENT',
    phase: 'confirmation',
    subject: {
      type: 'account', exchangeId: 'bitget', symbol: SYMBOL, field: 'balance'
    },
    expected: 'sufficient balance',
    actual: 'insufficient balance'
  });
  const cases = [
    {
      name: 'invalidate-undefined',
      operation: 'invalidate',
      thrown: undefined,
      actual: 'undefined-thrown'
    },
    {
      name: 'confirm-revoked-proxy',
      operation: 'confirm',
      thrown: revocable.proxy,
      actual: 'object-failure'
    }
  ] as const;

  for (const testCase of cases) {
    const strategyId = `unknown-write-${testCase.name}`;
    const repository = new ControlledRepository(strategy(strategyId));
    let preflight: ScriptedPreflight;
    if (testCase.operation === 'invalidate') {
      repository.invalidateError = testCase.thrown;
      preflight = new ScriptedPreflight(() => {
        throw businessFailure;
      });
    } else {
      repository.confirmError = testCase.thrown;
      preflight = scriptedResult(preview());
    }
    const service = new ConfirmationService(repository, preflight);

    const error = await captureRejection(service.confirm(strategyId));

    assertTradeOpsError(error, 'STORAGE_OPERATION_FAILED', 'storage');
    assert.equal(error.detail.actual, testCase.actual);
    assert.equal(repository.record.state, 'PENDING_CONFIRMATION');
    assert.equal(
      repository.confirmCalls.length,
      testCase.operation === 'confirm' ? 1 : 0
    );
    assert.equal(
      repository.invalidateCalls.length,
      testCase.operation === 'invalidate' ? 1 : 0
    );
    assert.deepEqual(repository.forbiddenCalls, []);
    assertLockAvailable(strategyId);
  }
  t.after(() => {
    for (const testCase of cases) {
      releaseStrategyOperation(`unknown-write-${testCase.name}`);
    }
  });
});

test('classifies hostile unknown revalidation failures without reading their properties', async (t) => {
  const { ConfirmationService } = await loadConfirmationModule();
  const secret = 'synthetic-revalidation-secret';
  let reads = 0;
  const getterObject: Record<string, unknown> = {};
  for (const property of ['name', 'message', 'code']) {
    Object.defineProperty(getterObject, property, {
      enumerable: true,
      get(): never {
        reads += 1;
        throw new Error(secret);
      }
    });
  }
  const proxy = new Proxy({}, {
    get(): never {
      reads += 1;
      throw new Error(secret);
    }
  });
  const revocable = Proxy.revocable({}, {});
  revocable.revoke();
  const cases: readonly unknown[] = [
    'first raw secret',
    'second raw secret',
    getterObject,
    proxy,
    revocable.proxy
  ];

  for (const [index, thrown] of cases.entries()) {
    const strategyId = `unknown-revalidation-${index}`;
    const repository = new ControlledRepository(strategy(strategyId));
    const preflight = new ScriptedPreflight(() => {
      throw thrown;
    });
    const service = new ConfirmationService(repository, preflight);

    const error = await captureRejection(service.confirm(strategyId));

    assertTradeOpsError(error, 'PREFLIGHT_INVALIDATED', 'confirmation');
    assert.equal(
      error.detail.actual,
      typeof thrown === 'string' ? 'string-thrown' : 'object-failure'
    );
    assert.equal(reads, 0);
    const rendered = JSON.stringify(error.detail);
    assert.equal(rendered.includes(secret), false);
    assert.equal(rendered.includes('raw secret'), false);
    assert.equal(repository.invalidateCalls.length, 1);
    assert.equal(repository.confirmCalls.length, 0);
    assertLockAvailable(strategyId);
  }
  t.after(() => {
    for (let index = 0; index < cases.length; index += 1) {
      releaseStrategyOperation(`unknown-revalidation-${index}`);
    }
  });
});

test('serializes concurrent confirmations across success, business failure, and read failure', async (t) => {
  const { ConfirmationService } = await loadConfirmationModule();
  const businessFailure = createTradeOpsError({
    code: 'BALANCE_UNAVAILABLE',
    phase: 'preflight',
    subject: {
      type: 'account', exchangeId: 'bitget', symbol: SYMBOL, field: 'balance'
    },
    expected: 'available USDT balance',
    actual: 'object-failure'
  });
  const revocable = Proxy.revocable({}, {});
  revocable.revoke();
  const cases = [
    { name: 'success', result: preview(), error: undefined },
    { name: 'business', result: undefined, error: businessFailure },
    { name: 'read', result: undefined, error: revocable.proxy }
  ] as const;

  for (const [index, testCase] of cases.entries()) {
    const strategyId = `concurrent-${index}`;
    const repository = new ControlledRepository(strategy(strategyId));
    const gate = deferred<PreflightResult>();
    const started = deferred<void>();
    const preflight = new ScriptedPreflight(async () => {
      started.resolve();
      return await gate.promise;
    });
    const service = new ConfirmationService(repository, preflight);
    const first = service.confirm(strategyId);
    await started.promise;

    const competingError = await captureRejection(service.confirm(strategyId));

    assertTradeOpsError(
      competingError,
      'STRATEGY_OPERATION_BUSY',
      'confirmation'
    );
    assert.deepEqual(repository.calls, ['getStrategy', 'listOrders']);
    assert.equal(preflight.calls.length, 1);
    assert.equal(repository.confirmCalls.length, 0);
    assert.equal(repository.invalidateCalls.length, 0);

    if (testCase.error === undefined) {
      gate.resolve(testCase.result as PreflightResult);
      await first;
      assert.equal(repository.confirmCalls.length, 1);
    } else {
      gate.reject(testCase.error);
      const firstError = await captureRejection(first);
      assertTradeOpsError(
        firstError,
        testCase.name === 'business'
          ? 'BALANCE_UNAVAILABLE'
          : 'PREFLIGHT_INVALIDATED',
        'confirmation'
      );
      assert.equal(repository.invalidateCalls.length, 1);
    }
    assertLockAvailable(strategyId);

    const callsBeforeRepeat = preflight.calls.length;
    const repeatedError = await captureRejection(service.confirm(strategyId));
    assertTradeOpsError(
      repeatedError,
      'STRATEGY_STATE_MISMATCH',
      'confirmation'
    );
    assert.equal(preflight.calls.length, callsBeforeRepeat);
    assertLockAvailable(strategyId);
  }
  t.after(() => {
    for (let index = 0; index < cases.length; index += 1) {
      releaseStrategyOperation(`concurrent-${index}`);
    }
  });
});

interface RealPreflightContext {
  readonly service: PreflightService;
  readonly spot: FakeExchangeGateway;
  readonly contract: FakeExchangeGateway;
  readonly input: PreflightInput;
}

function realPreflightContext(options: {
  readonly spot?: FakeExchangeGateway;
  readonly contract?: FakeExchangeGateway;
} = {}): RealPreflightContext {
  const spot = options.spot ?? new FakeExchangeGateway('bitget');
  const contract = options.contract ?? new FakeExchangeGateway('okx');
  spot.markets.set(`spot:${SYMBOL}`, market('bitget', 'spot'));
  contract.markets.set(`swap:${SYMBOL}`, market('okx', 'swap'));
  spot.lastPrices.set(`spot:${SYMBOL}`, '100');
  contract.lastPrices.set(`swap:${SYMBOL}`, '120');
  spot.freeUsdt = '1000';
  contract.freeUsdt = '1000';
  contract.accountSettings = {
    marginMode: 'cross', positionMode: 'hedged', leverage: '2'
  };
  return {
    service: new PreflightService(new ExchangeRegistry(new Map([
      ['bitget', spot],
      ['okx', contract]
    ])), () => new Date('2026-10-03T00:10:00.000Z')),
    spot,
    contract,
    input: {
      spotExchangeId: 'bitget',
      contractExchangeId: 'okx',
      symbol: SYMBOL,
      requestedBaseQuantity: '1',
      mode: 'CONCURRENT'
    }
  };
}

test('allows fresh prices and balances only after the real ordered preflight passes', async (t) => {
  const { ConfirmationService } = await loadConfirmationModule();
  const context = realPreflightContext();
  const original = await context.service.run(context.input);
  context.spot.marketLoadRequests.length = 0;
  context.contract.marketLoadRequests.length = 0;
  context.spot.lastPrices.set(`spot:${SYMBOL}`, '101');
  context.contract.lastPrices.set(`swap:${SYMBOL}`, '121');
  context.spot.freeUsdt = '999';
  context.contract.freeUsdt = '999';
  const strategyId = 'real-fresh-values';
  const repository = new ControlledRepository(strategy(strategyId, original));
  const service = new ConfirmationService(repository, context.service);
  t.after(() => releaseStrategyOperation(strategyId));

  await service.confirm(strategyId);

  assert.equal(repository.record.state, 'EXECUTING');
  assert.deepEqual(context.spot.marketLoadRequests, [{
    symbol: SYMBOL, kind: 'spot', reload: true
  }]);
  assert.deepEqual(context.contract.marketLoadRequests, [{
    symbol: SYMBOL, kind: 'swap', reload: true
  }]);
  assert.equal(context.spot.createdRequests.length, 0);
  assert.equal(context.contract.createdRequests.length, 0);
  assertLockAvailable(strategyId);
});

test('enforces exact spot and leveraged contract balance boundaries on confirmation', async (t) => {
  const { ConfirmationService } = await loadConfirmationModule();
  const cases = [
    { name: 'spot exact', spot: '100', contract: '1000', passes: true },
    { name: 'spot below', spot: '99.9999', contract: '1000', passes: false },
    { name: 'contract exact', spot: '1000', contract: '60', passes: true },
    { name: 'contract below', spot: '1000', contract: '59.9999', passes: false }
  ] as const;

  for (const [index, testCase] of cases.entries()) {
    const context = realPreflightContext();
    const original = await context.service.run(context.input);
    context.spot.freeUsdt = testCase.spot;
    context.contract.freeUsdt = testCase.contract;
    const strategyId = `balance-boundary-${index}`;
    const repository = new ControlledRepository(strategy(strategyId, original));
    const service = new ConfirmationService(repository, context.service);

    if (testCase.passes) {
      await service.confirm(strategyId);
      assert.equal(repository.record.state, 'EXECUTING', testCase.name);
      assert.equal(repository.invalidateCalls.length, 0, testCase.name);
    } else {
      const error = await captureRejection(service.confirm(strategyId));
      assertTradeOpsError(error, 'BALANCE_INSUFFICIENT', 'confirmation');
      assert.equal(repository.record.state, 'PREFLIGHT_INVALIDATED');
      assert.equal(repository.invalidateCalls.length, 1, testCase.name);
    }
    assert.equal(context.spot.createdRequests.length, 0);
    assert.equal(context.contract.createdRequests.length, 0);
    assertLockAvailable(strategyId);
  }
  t.after(() => {
    for (let index = 0; index < cases.length; index += 1) {
      releaseStrategyOperation(`balance-boundary-${index}`);
    }
  });
});

class FailingRefreshGateway extends FakeExchangeGateway {
  failRefresh = false;
  refreshAttempts = 0;

  override async loadMarketSnapshot(
    symbol: string,
    kind: MarketKind,
    options: MarketLoadOptions = {}
  ): Promise<LoadedMarketSnapshot> {
    this.refreshAttempts += 1;
    if (this.failRefresh && options.reload === true) {
      throw new Error('synthetic-raw-refresh-secret');
    }
    return await super.loadMarketSnapshot(symbol, kind, options);
  }
}

test('invalidates changed refreshed rules and never falls back after refresh failure', async (t) => {
  const { ConfirmationService } = await loadConfirmationModule();

  {
    const context = realPreflightContext();
    const original = await context.service.run(context.input);
    context.spot.markets.set(`spot:${SYMBOL}`, market('bitget', 'spot', {
      amountStep: '0.0002'
    }));
    const strategyId = 'real-rule-drift';
    const repository = new ControlledRepository(strategy(strategyId, original));
    const service = new ConfirmationService(repository, context.service);

    const error = await captureRejection(service.confirm(strategyId));

    assertTradeOpsError(error, 'PREFLIGHT_INVALIDATED', 'confirmation');
    assert.equal(repository.record.state, 'PREFLIGHT_INVALIDATED');
    assert.equal(context.spot.createdRequests.length, 0);
    assert.equal(context.contract.createdRequests.length, 0);
    assertLockAvailable(strategyId);
  }

  {
    const spot = new FailingRefreshGateway('bitget');
    const contract = new FakeExchangeGateway('okx');
    const context = realPreflightContext({ spot, contract });
    const original = await context.service.run(context.input);
    const priorSnapshot = structuredClone(spot.markets.get(`spot:${SYMBOL}`));
    assert.ok(priorSnapshot);
    spot.markets.set(`spot:${SYMBOL}`, { ...priorSnapshot, amountStep: '0.5' });
    spot.failRefresh = true;
    const contractLoadsBefore = contract.marketLoadRequests.length;
    const strategyId = 'real-refresh-failure';
    const repository = new ControlledRepository(strategy(strategyId, original));
    const service = new ConfirmationService(repository, context.service);

    const error = await captureRejection(service.confirm(strategyId));

    assertTradeOpsError(error, 'MARKET_UNAVAILABLE', 'confirmation');
    assert.equal(JSON.stringify(error.detail).includes('raw-refresh-secret'), false);
    assert.equal(repository.record.state, 'PREFLIGHT_INVALIDATED');
    assert.equal(contract.marketLoadRequests.length, contractLoadsBefore);
    assert.equal(spot.balanceRequests.length, 1, 'only initial preflight read balance');
    assert.equal(contract.balanceRequests.length, 1, 'only initial preflight read balance');
    assert.equal(spot.createdRequests.length, 0);
    assert.equal(contract.createdRequests.length, 0);
    assertLockAvailable(strategyId);
  }

  t.after(() => {
    releaseStrategyOperation('real-rule-drift');
    releaseStrategyOperation('real-refresh-failure');
  });
});
