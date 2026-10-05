/// <reference types="node" />

import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import {
  createTradeOpsError,
  parseErrorDetail,
  projectTradeOpsError,
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
  preflight: Pick<PreflightService, 'run'>,
  secretProvider?: () => readonly string[]
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
  writeHook: ((
    operation: 'confirm' | 'invalidate',
    expected: Readonly<StrategyRecord>,
    failure?: ErrorDetail
  ) => void) | undefined;

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
    this.writeHook?.('confirm', expected);
    if (this.confirmError !== NO_ERROR) throw this.confirmError;
    this.record = { ...this.record, state: 'EXECUTING' };
  }

  invalidatePreflight(
    expected: Readonly<StrategyRecord>,
    failure: ErrorDetail
  ): void {
    this.calls.push('invalidatePreflight');
    this.invalidateCalls.push({ expected, failure });
    this.writeHook?.('invalidate', expected, failure);
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
  let rebuilt: TradeOpsError;
  try {
    rebuilt = withErrorPhase(error as TradeOpsError, phase);
  } catch {
    assert.fail(`expected WeakMap-branded ${code} TradeOpsError`);
  }
  const precise = error as TradeOpsError;
  assert.deepEqual(precise.detail, rebuilt.detail);
  assert.equal(precise.detail.code, code);
  assert.equal(precise.detail.phase, phase);
  assert.deepEqual(precise.detail.subject, rebuilt.detail.subject);
  assert.notEqual(precise.detail.expected, null);
  assert.notEqual(precise.detail.actual, null);
  assert.match(precise.detail.message, /检查失败/u);
  assert.equal(precise.detail.message, rebuilt.detail.message);
  assert.equal(precise.detail.occurredAt, rebuilt.detail.occurredAt);
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

const LONG_PRECISION_DRIFT_CASES = [
  {
    name: 'effective base quantity',
    field: 'effectiveBaseQuantity',
    expected: '12345678901234567890123456789012345678901',
    actual: '12345678901234567890123456789012345678902',
    change(value: PreflightResult, decimalValue: string): void {
      value.effectiveBaseQuantity = decimalValue;
    }
  },
  {
    name: 'spot amount step',
    field: 'amountStep',
    expected: '0.10000000000000000000000000000000000000001',
    actual: '0.10000000000000000000000000000000000000002',
    change(value: PreflightResult, decimalValue: string): void {
      value.spotMarket.amountStep = decimalValue;
    }
  },
  {
    name: 'contract size',
    field: 'contractSize',
    expected: '1.00000000000000000000000000000000000000001',
    actual: '1.00000000000000000000000000000000000000002',
    change(value: PreflightResult, decimalValue: string): void {
      value.contractMarket.contractSize = decimalValue;
    }
  },
  {
    name: 'contract maximum base amount',
    field: 'maxBaseAmount',
    expected: '12345678901234567890123456789012345678901',
    actual: '12345678901234567890123456789012345678902',
    change(value: PreflightResult, decimalValue: string): void {
      value.contractMarket.maxBaseAmount = decimalValue;
    }
  }
] as const;

test(
  'distinguishes more-than-40-digit changes in every protected decimal category',
  async (t) => {
    const { ConfirmationService } = await loadConfirmationModule();

    for (const [index, testCase] of LONG_PRECISION_DRIFT_CASES.entries()) {
      const original = preview();
      testCase.change(original, testCase.expected);
      const refreshed = structuredClone(original);
      testCase.change(refreshed, testCase.actual);
      const strategyId = `long-precision-drift-${index}`;
      const repository = new ControlledRepository(strategy(strategyId, original));
      const service = new ConfirmationService(
        repository,
        scriptedResult(refreshed)
      );

      const error = await captureRejection(service.confirm(strategyId));

      assertTradeOpsError(error, 'PREFLIGHT_INVALIDATED', 'confirmation');
      assert.equal(error.detail.expected, testCase.expected, testCase.name);
      assert.equal(error.detail.actual, testCase.actual, testCase.name);
      assert.equal(
        'field' in error.detail.subject ? error.detail.subject.field : undefined,
        testCase.field,
        testCase.name
      );
      assert.equal(repository.invalidateCalls.length, 1, testCase.name);
      assert.deepEqual(
        repository.invalidateCalls[0]?.failure,
        error.detail,
        testCase.name
      );
      assert.equal(repository.confirmCalls.length, 0, testCase.name);
      assert.equal(repository.record.state, 'PREFLIGHT_INVALIDATED', testCase.name);
      assert.deepEqual(repository.orders, [], testCase.name);
      assert.deepEqual(repository.forbiddenCalls, [], testCase.name);
      assertLockAvailable(strategyId);
    }
    t.after(() => {
      for (let index = 0; index < LONG_PRECISION_DRIFT_CASES.length; index += 1) {
        releaseStrategyOperation(`long-precision-drift-${index}`);
      }
    });
  }
);

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
  const expectedPersisted = projectTradeOpsError(
    expectedFailure,
    [],
    false
  );
  assert.deepEqual(
    repository.invalidateCalls[0]?.failure,
    expectedPersisted
  );
  assert.notEqual(expectedPersisted.evidence, undefined);
  assert.doesNotMatch(JSON.stringify(expectedPersisted), /"stack"/);
  assert.equal(repository.record.state, 'PREFLIGHT_INVALIDATED');
  assert.equal(repository.confirmCalls.length, 0);
  assertLockAvailable(strategyId);
});

test('persists sanitized native revalidation evidence without stack', async (t) => {
  const { ConfirmationService } = await loadConfirmationModule();
  const strategyId = 'native-revalidation-evidence';
  const configuredSecret = 'SYNTHETIC-CONFIRMATION-CONFIGURED-SECRET';
  const repository = new ControlledRepository(strategy(strategyId));
  const nativeFailure = Object.assign(
    new Error(`account snapshot unavailable ${configuredSecret}`, {
      cause: new Error(`gateway connection reset ${configuredSecret}`)
    }),
    {
      code: 'ACCOUNT_SNAPSHOT_FAILED',
      response: {
        status: 503,
        body: `temporary maintenance ${configuredSecret}`
      }
    }
  );
  const preflight = new ScriptedPreflight(() => {
    throw nativeFailure;
  });
  const service = new ConfirmationService(
    repository,
    preflight,
    () => [configuredSecret]
  );
  t.after(() => releaseStrategyOperation(strategyId));

  const error = await captureRejection(service.confirm(strategyId));

  assertTradeOpsError(error, 'PREFLIGHT_INVALIDATED', 'confirmation');
  const runtimeProjection = projectTradeOpsError(
    error,
    [configuredSecret],
    true
  );
  const runtimeSerialized = JSON.stringify(runtimeProjection);
  assert.match(runtimeSerialized, /account snapshot unavailable/);
  assert.match(runtimeSerialized, /gateway connection reset/);
  assert.match(runtimeSerialized, /ACCOUNT_SNAPSHOT_FAILED/);
  assert.match(runtimeSerialized, /503/);
  assert.match(runtimeSerialized, /temporary maintenance/);
  assert.match(runtimeSerialized, /"stack"/);
  assert.doesNotMatch(runtimeSerialized, new RegExp(configuredSecret));

  assert.equal(repository.invalidateCalls.length, 1);
  const persisted = parseErrorDetail(structuredClone(
    repository.invalidateCalls[0]?.failure
  ));
  const persistedSerialized = JSON.stringify(persisted);
  assert.match(persistedSerialized, /account snapshot unavailable/);
  assert.match(persistedSerialized, /gateway connection reset/);
  assert.match(persistedSerialized, /ACCOUNT_SNAPSHOT_FAILED/);
  assert.match(persistedSerialized, /503/);
  assert.match(persistedSerialized, /temporary maintenance/);
  assert.doesNotMatch(persistedSerialized, /"stack"/);
  assert.doesNotMatch(persistedSerialized, new RegExp(configuredSecret));
  assert.deepEqual(repository.record.preflightFailure, persisted);
  assert.deepEqual(repository.calls, [
    'getStrategy',
    'listOrders',
    'invalidatePreflight'
  ]);
  assert.equal(repository.confirmCalls.length, 0);
  assert.deepEqual(repository.forbiddenCalls, []);
  assertLockAvailable(strategyId);
});

test('retains revalidation and storage causes when invalidation write fails', async (t) => {
  const { ConfirmationService } = await loadConfirmationModule();
  const strategyId = 'invalidation-write-double-failure';
  const configuredSecret = 'SYNTHETIC-DOUBLE-FAILURE-SECRET';
  const repository = new ControlledRepository(strategy(strategyId));
  repository.invalidateError = Object.assign(
    new Error(`SQLite invalidation write failed ${configuredSecret}`),
    { code: 'SQLITE_IOERR_WRITE' }
  );
  const preflight = new ScriptedPreflight(() => {
    throw Object.assign(
      new Error(`account balance refresh failed ${configuredSecret}`),
      { code: 'BALANCE_REFRESH_FAILED' }
    );
  });
  const service = new ConfirmationService(
    repository,
    preflight,
    () => [configuredSecret]
  );
  t.after(() => releaseStrategyOperation(strategyId));

  const error = await captureRejection(service.confirm(strategyId));

  assertTradeOpsError(error, 'STORAGE_OPERATION_FAILED', 'storage');
  const serialized = JSON.stringify(projectTradeOpsError(
    error,
    [configuredSecret],
    true
  ));
  const businessIndex = serialized.indexOf('account balance refresh failed');
  const storageIndex = serialized.indexOf('SQLite invalidation write failed');
  assert.ok(businessIndex >= 0);
  assert.ok(storageIndex > businessIndex);
  assert.match(serialized, /BALANCE_REFRESH_FAILED/);
  assert.match(serialized, /SQLITE_IOERR_WRITE/);
  assert.doesNotMatch(serialized, new RegExp(configuredSecret));
  assert.equal(repository.record.state, 'PENDING_CONFIRMATION');
  assert.deepEqual(repository.calls, [
    'getStrategy',
    'listOrders',
    'invalidatePreflight'
  ]);
  assert.equal(repository.invalidateCalls.length, 1);
  assert.equal(repository.confirmCalls.length, 0);
  assert.deepEqual(repository.forbiddenCalls, []);
  assertLockAvailable(strategyId);
});

test('fails closed before invalidation when the secret provider throws', async (t) => {
  const { ConfirmationService } = await loadConfirmationModule();
  const strategyId = 'secret-provider-fail-closed';
  const rawFailureSecret = 'RAW-REVALIDATION-PAYLOAD-SECRET';
  const providerSecret = 'SECRET-PROVIDER-FAILURE-SENTINEL';
  const repository = new ControlledRepository(strategy(strategyId));
  const preflight = new ScriptedPreflight(() => {
    throw new Error(`account refresh failed ${rawFailureSecret}`);
  });
  const service = new ConfirmationService(
    repository,
    preflight,
    () => {
      throw new Error(`secret provider unavailable ${providerSecret}`);
    }
  );
  t.after(() => releaseStrategyOperation(strategyId));

  const error = await captureRejection(service.confirm(strategyId));

  assertTradeOpsError(error, 'STORAGE_OPERATION_FAILED', 'storage');
  const serialized = JSON.stringify(projectTradeOpsError(
    error,
    [rawFailureSecret, providerSecret],
    false
  ));
  const businessIndex = serialized.indexOf('account refresh failed');
  const projectionIndex = serialized.indexOf('secret provider unavailable');
  assert.ok(businessIndex >= 0);
  assert.ok(projectionIndex > businessIndex);
  assert.doesNotMatch(
    serialized,
    new RegExp(`${rawFailureSecret}|${providerSecret}`)
  );
  assert.doesNotMatch(serialized, /"stack"/);
  assert.equal(repository.record.state, 'PENDING_CONFIRMATION');
  assert.equal(repository.record.preflightFailure, null);
  assert.deepEqual(repository.calls, ['getStrategy', 'listOrders']);
  assert.equal(repository.invalidateCalls.length, 0);
  assert.equal(repository.confirmCalls.length, 0);
  assert.deepEqual(repository.forbiddenCalls, []);
  assert.doesNotMatch(
    JSON.stringify(repository.record),
    new RegExp(`${rawFailureSecret}|${providerSecret}`)
  );
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

interface ConditionalRejectionCase {
  readonly name: string;
  readonly actual: string;
  readonly expectedEvidence: unknown;
  readonly expectedOrderCount: number;
  mutate(repository: ControlledRepository, strategyId: string): void;
  evidence(repository: ControlledRepository): unknown;
}

const CONDITIONAL_REJECTION_CASES: readonly ConditionalRejectionCase[] = [
  {
    name: 'state changed',
    actual: 'state-changed',
    expectedEvidence: 'EXECUTING',
    expectedOrderCount: 0,
    mutate(repository): void {
      repository.record = { ...repository.record, state: 'EXECUTING' };
    },
    evidence: (repository) => repository.record.state
  },
  {
    name: 'strategy orders present',
    actual: 'strategy-orders-present',
    expectedEvidence: [{ id: 'order-1', role: 'SPOT_MARKET' }],
    expectedOrderCount: 1,
    mutate(repository, strategyId): void {
      repository.orders = [plannedOrder(strategyId)];
    },
    evidence: (repository) => repository.orders.map(({ id, role }) => ({ id, role }))
  },
  {
    name: 'execution failure present',
    actual: 'execution-failure-present',
    expectedEvidence: 'ORDER_SUBMISSION_FAILED',
    expectedOrderCount: 0,
    mutate(repository): void {
      repository.record = {
        ...repository.record,
        failureCode: 'ORDER_SUBMISSION_FAILED'
      };
    },
    evidence: (repository) => repository.record.failureCode
  },
  {
    name: 'preflight failure present',
    actual: 'preflight-failure-present',
    expectedEvidence: 'BALANCE_INSUFFICIENT',
    expectedOrderCount: 0,
    mutate(repository): void {
      repository.record = {
        ...repository.record,
        preflightFailure: createTradeOpsError({
          code: 'BALANCE_INSUFFICIENT',
          phase: 'confirmation',
          subject: {
            type: 'account', exchangeId: 'bitget', symbol: SYMBOL, field: 'balance'
          },
          expected: 'sufficient balance',
          actual: 'insufficient balance',
          occurredAt: '2026-10-03T00:19:00.000Z'
        }).detail
      };
    },
    evidence: (repository) => repository.record.preflightFailure?.code
  },
  {
    name: 'spot exchange identity changed',
    actual: 'spot-exchange-id-changed',
    expectedEvidence: 'other',
    expectedOrderCount: 0,
    mutate(repository): void {
      repository.record = { ...repository.record, spotExchangeId: 'other' };
    },
    evidence: (repository) => repository.record.spotExchangeId
  },
  {
    name: 'preflight snapshot changed',
    actual: 'preflight-snapshot-changed',
    expectedEvidence: '0.0002',
    expectedOrderCount: 0,
    mutate(repository): void {
      const changed = structuredClone(repository.record.preflight);
      changed.spotMarket.amountStep = '0.0002';
      repository.record = { ...repository.record, preflight: changed };
    },
    evidence: (repository) => repository.record.preflight.spotMarket.amountStep
  },
  {
    name: 'conditional CAS updated zero rows',
    actual: 'conditional-confirmation-cas-updated-zero-rows',
    expectedEvidence: 'PENDING_CONFIRMATION',
    expectedOrderCount: 0,
    mutate(): void {},
    evidence: (repository) => repository.record.state
  }
];

test(
  'rejects every confirmation storage precondition without secondary writes',
  async (t) => {
    const { ConfirmationService } = await loadConfirmationModule();
    const businessFailure = createTradeOpsError({
      code: 'BALANCE_INSUFFICIENT',
      phase: 'confirmation',
      subject: {
        type: 'account', exchangeId: 'bitget', symbol: SYMBOL, field: 'balance'
      },
      expected: 'USDT capacity at least 100',
      actual: '99',
      occurredAt: '2026-10-03T00:18:00.000Z'
    });
    const strategyIds: string[] = [];

    for (const [caseIndex, testCase] of CONDITIONAL_REJECTION_CASES.entries()) {
      for (const operation of ['confirm', 'invalidate'] as const) {
        const strategyId = `conditional-${caseIndex}-${operation}`;
        strategyIds.push(strategyId);
        const repository = new ControlledRepository(strategy(strategyId));
        const rejection = createTradeOpsError({
          code: 'STORAGE_TRANSITION_REJECTED',
          phase: 'storage',
          subject: { type: 'strategy', strategyId },
          expected: 'unchanged pending confirmation snapshot without failures or orders',
          actual: testCase.actual,
          occurredAt: '2026-10-03T00:20:00.000Z'
        });
        repository.writeHook = (attempt, _expected, failure) => {
          assert.equal(attempt, operation, testCase.name);
          if (operation === 'invalidate') {
            assert.deepEqual(failure, businessFailure.detail, testCase.name);
          } else {
            assert.equal(failure, undefined, testCase.name);
          }
          testCase.mutate(repository, strategyId);
          throw rejection;
        };
        const preflight = operation === 'confirm'
          ? scriptedResult(preview())
          : new ScriptedPreflight(() => {
              throw businessFailure;
            });
        const service = new ConfirmationService(repository, preflight);

        const error = await captureRejection(service.confirm(strategyId));

        assertTradeOpsError(error, 'STORAGE_TRANSITION_REJECTED', 'storage');
        assert.deepEqual(error.detail, rejection.detail, testCase.name);
        assert.deepEqual(
          error.detail.subject,
          { type: 'strategy', strategyId },
          testCase.name
        );
        assert.equal(
          error.detail.expected,
          'unchanged pending confirmation snapshot without failures or orders',
          testCase.name
        );
        assert.equal(error.detail.actual, testCase.actual, testCase.name);
        assert.deepEqual(
          testCase.evidence(repository),
          testCase.expectedEvidence,
          `${operation}: ${testCase.name}`
        );
        assert.equal(
          repository.confirmCalls.length,
          operation === 'confirm' ? 1 : 0,
          `${operation}: ${testCase.name}`
        );
        assert.equal(
          repository.invalidateCalls.length,
          operation === 'invalidate' ? 1 : 0,
          `${operation}: ${testCase.name}`
        );
        assert.equal(
          repository.orders.length,
          testCase.expectedOrderCount,
          `${operation}: ${testCase.name}`
        );
        assert.deepEqual(repository.forbiddenCalls, [], testCase.name);
        assertLockAvailable(strategyId);
      }
    }
    t.after(() => {
      for (const strategyId of strategyIds) releaseStrategyOperation(strategyId);
    });
  }
);

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

class ObservedPreflightGateway extends FakeExchangeGateway {
  failRefresh = false;
  refreshAttempts = 0;
  accountSettingsRequests = 0;
  lastPriceRequests = 0;

  override async loadMarketSnapshot(
    symbol: string,
    kind: MarketKind,
    options: MarketLoadOptions = {}
  ): Promise<LoadedMarketSnapshot> {
    this.refreshAttempts += 1;
    if (this.failRefresh && options.reload === true) {
      this.marketLoadRequests.push({ symbol, kind, reload: true });
      throw new Error('synthetic-raw-refresh-secret');
    }
    return await super.loadMarketSnapshot(symbol, kind, options);
  }

  override async fetchAccountSettings(symbol: string): Promise<AccountSettings> {
    this.accountSettingsRequests += 1;
    return await super.fetchAccountSettings(symbol);
  }

  override async fetchLastPrice(
    symbol: string,
    kind: MarketKind
  ): Promise<string> {
    this.lastPriceRequests += 1;
    return await super.fetchLastPrice(symbol, kind);
  }

  resetObservations(): void {
    this.refreshAttempts = 0;
    this.accountSettingsRequests = 0;
    this.lastPriceRequests = 0;
    this.marketLoadRequests.length = 0;
    this.balanceRequests.length = 0;
    this.createdRequests.length = 0;
  }
}

interface RealPreflightContext {
  readonly service: PreflightService;
  readonly spot: ObservedPreflightGateway;
  readonly contract: ObservedPreflightGateway;
  readonly input: PreflightInput;
}

function realPreflightContext(options: {
  readonly spot?: ObservedPreflightGateway;
  readonly contract?: ObservedPreflightGateway;
} = {}): RealPreflightContext {
  const spot = options.spot ?? new ObservedPreflightGateway('bitget');
  const contract = options.contract ?? new ObservedPreflightGateway('okx');
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

interface PreflightReadCounts {
  readonly spotRefresh: number;
  readonly contractRefresh: number;
  readonly contractSettings: number;
  readonly spotPrices: number;
  readonly contractPrices: number;
  readonly spotBalances: number;
  readonly contractBalances: number;
}

function changeObservedMarket(
  gateway: ObservedPreflightGateway,
  kind: MarketKind,
  change: Partial<MarketRules>
): void {
  const key = `${kind}:${SYMBOL}`;
  const configured = gateway.markets.get(key);
  assert.ok(configured);
  gateway.markets.set(key, { ...configured, ...change });
}

function assertPreflightReads(
  context: RealPreflightContext,
  expected: PreflightReadCounts,
  message: string
): void {
  assert.deepEqual(context.spot.marketLoadRequests, expected.spotRefresh === 0
    ? []
    : [{ symbol: SYMBOL, kind: 'spot', reload: true }], message);
  assert.deepEqual(context.contract.marketLoadRequests, expected.contractRefresh === 0
    ? []
    : [{ symbol: SYMBOL, kind: 'swap', reload: true }], message);
  assert.equal(context.spot.refreshAttempts, expected.spotRefresh, message);
  assert.equal(context.contract.refreshAttempts, expected.contractRefresh, message);
  assert.equal(context.spot.accountSettingsRequests, 0, message);
  assert.equal(
    context.contract.accountSettingsRequests,
    expected.contractSettings,
    message
  );
  assert.equal(context.spot.lastPriceRequests, expected.spotPrices, message);
  assert.equal(context.contract.lastPriceRequests, expected.contractPrices, message);
  assert.equal(context.spot.balanceRequests.length, expected.spotBalances, message);
  assert.equal(
    context.contract.balanceRequests.length,
    expected.contractBalances,
    message
  );
}

interface DirectPreflightFailureCase {
  readonly name: string;
  readonly code: ErrorCode;
  readonly subject: ErrorDetail['subject'];
  readonly expected: ErrorDetail['expected'];
  readonly actual: ErrorDetail['actual'];
  readonly reads: PreflightReadCounts;
  mutate(context: RealPreflightContext): void;
}

const DIRECT_PREFLIGHT_FAILURE_CASES: readonly DirectPreflightFailureCase[] = [
  {
    name: 'R21-01 spot exchange identity mismatch',
    code: 'MARKET_IDENTITY_MISMATCH',
    subject: {
      type: 'market', exchangeId: 'bitget', symbol: SYMBOL,
      kind: 'spot', field: 'exchangeId'
    },
    expected: 'bitget',
    actual: 'other',
    reads: {
      spotRefresh: 1, contractRefresh: 0, contractSettings: 0,
      spotPrices: 0, contractPrices: 0, spotBalances: 0, contractBalances: 0
    },
    mutate: (context) => changeObservedMarket(context.spot, 'spot', {
      exchangeId: 'other'
    })
  },
  {
    name: 'R21-02 contract kind identity mismatch',
    code: 'MARKET_IDENTITY_MISMATCH',
    subject: {
      type: 'market', exchangeId: 'okx', symbol: SYMBOL,
      kind: 'swap', field: 'kind'
    },
    expected: 'swap',
    actual: 'spot',
    reads: {
      spotRefresh: 1, contractRefresh: 1, contractSettings: 0,
      spotPrices: 0, contractPrices: 0, spotBalances: 0, contractBalances: 0
    },
    mutate: (context) => changeObservedMarket(context.contract, 'swap', {
      kind: 'spot'
    })
  },
  {
    name: 'R21-03 spot inactive',
    code: 'MARKET_INACTIVE',
    subject: {
      type: 'market', exchangeId: 'bitget', symbol: SYMBOL,
      kind: 'spot', field: 'active'
    },
    expected: true,
    actual: false,
    reads: {
      spotRefresh: 1, contractRefresh: 0, contractSettings: 0,
      spotPrices: 0, contractPrices: 0, spotBalances: 0, contractBalances: 0
    },
    mutate: (context) => changeObservedMarket(context.spot, 'spot', {
      active: false
    })
  },
  {
    name: 'R21-04 contract inactive',
    code: 'MARKET_INACTIVE',
    subject: {
      type: 'market', exchangeId: 'okx', symbol: SYMBOL,
      kind: 'swap', field: 'active'
    },
    expected: true,
    actual: false,
    reads: {
      spotRefresh: 1, contractRefresh: 1, contractSettings: 0,
      spotPrices: 0, contractPrices: 0, spotBalances: 0, contractBalances: 0
    },
    mutate: (context) => changeObservedMarket(context.contract, 'swap', {
      active: false
    })
  },
  {
    name: 'R21-05 invalid spot amount step',
    code: 'MARKET_RULE_INVALID',
    subject: {
      type: 'market', exchangeId: 'bitget', symbol: SYMBOL,
      kind: 'spot', field: 'amountStep'
    },
    expected: 'finite decimal greater than zero',
    actual: '0',
    reads: {
      spotRefresh: 1, contractRefresh: 1, contractSettings: 1,
      spotPrices: 0, contractPrices: 0, spotBalances: 0, contractBalances: 0
    },
    mutate: (context) => changeObservedMarket(context.spot, 'spot', {
      amountStep: '0'
    })
  },
  {
    name: 'R21-06 contract notional below changed minimum',
    code: 'NOTIONAL_OUT_OF_RANGE',
    subject: {
      type: 'market', exchangeId: 'okx', symbol: SYMBOL,
      kind: 'swap', field: 'notional'
    },
    expected: 'at least 200',
    actual: '120',
    reads: {
      spotRefresh: 1, contractRefresh: 1, contractSettings: 1,
      spotPrices: 1, contractPrices: 1, spotBalances: 0, contractBalances: 0
    },
    mutate: (context) => changeObservedMarket(context.contract, 'swap', {
      minQuoteNotional: '200'
    })
  },
  {
    name: 'R21-07 spot forced refresh failure',
    code: 'MARKET_UNAVAILABLE',
    subject: {
      type: 'market', exchangeId: 'bitget', symbol: SYMBOL, kind: 'spot'
    },
    expected: 'successful forced market refresh',
    actual: 'object-failure',
    reads: {
      spotRefresh: 1, contractRefresh: 0, contractSettings: 0,
      spotPrices: 0, contractPrices: 0, spotBalances: 0, contractBalances: 0
    },
    mutate(context): void { context.spot.failRefresh = true; }
  },
  {
    name: 'R21-08 contract forced refresh failure',
    code: 'MARKET_UNAVAILABLE',
    subject: {
      type: 'market', exchangeId: 'okx', symbol: SYMBOL, kind: 'swap'
    },
    expected: 'successful forced market refresh',
    actual: 'object-failure',
    reads: {
      spotRefresh: 1, contractRefresh: 1, contractSettings: 0,
      spotPrices: 0, contractPrices: 0, spotBalances: 0, contractBalances: 0
    },
    mutate(context): void { context.contract.failRefresh = true; }
  }
];

const LEGAL_PREFLIGHT_DRIFT_CASES = [
  {
    name: 'R21-09 spot amount step', side: 'spot', field: 'amountStep',
    expected: '0.0001', actual: '0.0002'
  },
  {
    name: 'R21-10 contract amount step', side: 'contract', field: 'amountStep',
    expected: '1', actual: '2'
  },
  {
    name: 'R21-11 spot price step', side: 'spot', field: 'priceStep',
    expected: '0.1', actual: '0.2'
  },
  {
    name: 'R21-12 contract price step', side: 'contract', field: 'priceStep',
    expected: '0.1', actual: '0.2'
  },
  {
    name: 'R21-13 spot contract size', side: 'spot', field: 'contractSize',
    expected: '1', actual: '2'
  },
  {
    name: 'R21-14 contract contract size', side: 'contract', field: 'contractSize',
    expected: '0.001', actual: '0.002'
  },
  {
    name: 'R21-15 spot minimum base amount', side: 'spot', field: 'minBaseAmount',
    expected: '0.001', actual: '0.002'
  },
  {
    name: 'R21-16 contract maximum base amount',
    side: 'contract', field: 'maxBaseAmount', expected: '1000', actual: '999'
  },
  {
    name: 'R21-17 spot minimum quote notional',
    side: 'spot', field: 'minQuoteNotional', expected: '5', actual: '6'
  },
  {
    name: 'R21-18 contract maximum quote notional',
    side: 'contract', field: 'maxQuoteNotional',
    expected: '1000000', actual: '999999'
  }
] as const;

const FULL_PREFLIGHT_READS: PreflightReadCounts = {
  spotRefresh: 1,
  contractRefresh: 1,
  contractSettings: 1,
  spotPrices: 1,
  contractPrices: 1,
  spotBalances: 1,
  contractBalances: 1
};

test(
  'invalidates changed refreshed rules only after the real ordered preflight boundary',
  async (t) => {
    const { ConfirmationService } = await loadConfirmationModule();
    const strategyIds: string[] = [];

    for (const [caseIndex, testCase] of DIRECT_PREFLIGHT_FAILURE_CASES.entries()) {
      const context = realPreflightContext();
      const original = await context.service.run(context.input);
      context.spot.resetObservations();
      context.contract.resetObservations();
      testCase.mutate(context);
      const strategyId = `real-direct-failure-${caseIndex}`;
      strategyIds.push(strategyId);
      const repository = new ControlledRepository(strategy(strategyId, original));
      const service = new ConfirmationService(repository, context.service);

      const error = await captureRejection(service.confirm(strategyId));

      assertTradeOpsError(error, testCase.code, 'confirmation');
      assert.deepEqual(error.detail.subject, testCase.subject, testCase.name);
      assert.equal(error.detail.expected, testCase.expected, testCase.name);
      assert.equal(error.detail.actual, testCase.actual, testCase.name);
      assert.equal(
        JSON.stringify(error.detail).includes('synthetic-raw-refresh-secret'),
        false,
        testCase.name
      );
      assert.equal(repository.invalidateCalls.length, 1, testCase.name);
      const persistedFailure = parseErrorDetail(structuredClone(
        repository.invalidateCalls[0]?.failure
      ));
      const projectedFailure = projectTradeOpsError(
        error as TradeOpsError,
        [],
        false
      );
      assert.deepEqual(
        persistedFailure,
        projectedFailure,
        testCase.name
      );
      assert.notEqual(persistedFailure.evidence, undefined, testCase.name);
      const persistedSerialized = JSON.stringify(persistedFailure);
      assert.match(persistedSerialized, /TradeOpsError/, testCase.name);
      assert.match(
        persistedSerialized,
        new RegExp(String(testCase.actual).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')),
        testCase.name
      );
      assert.doesNotMatch(persistedSerialized, /"stack"/, testCase.name);
      assert.equal(repository.confirmCalls.length, 0, testCase.name);
      assert.equal(repository.record.state, 'PREFLIGHT_INVALIDATED', testCase.name);
      assertPreflightReads(context, testCase.reads, testCase.name);
      assert.equal(context.spot.createdRequests.length, 0, testCase.name);
      assert.equal(context.contract.createdRequests.length, 0, testCase.name);
      assert.deepEqual(repository.forbiddenCalls, [], testCase.name);
      assertLockAvailable(strategyId);
    }

    for (const [caseIndex, testCase] of LEGAL_PREFLIGHT_DRIFT_CASES.entries()) {
      const context = realPreflightContext();
      const original = await context.service.run(context.input);
      context.spot.resetObservations();
      context.contract.resetObservations();
      const gateway = testCase.side === 'spot' ? context.spot : context.contract;
      const kind = testCase.side === 'spot' ? 'spot' : 'swap';
      changeObservedMarket(gateway, kind, { [testCase.field]: testCase.actual });
      const strategyId = `real-legal-drift-${caseIndex}`;
      strategyIds.push(strategyId);
      const repository = new ControlledRepository(strategy(strategyId, original));
      const service = new ConfirmationService(repository, context.service);

      const error = await captureRejection(service.confirm(strategyId));

      assertTradeOpsError(error, 'PREFLIGHT_INVALIDATED', 'confirmation');
      assert.deepEqual(error.detail.subject, {
        type: 'market',
        exchangeId: testCase.side === 'spot' ? 'bitget' : 'okx',
        symbol: SYMBOL,
        kind,
        field: testCase.field
      }, testCase.name);
      assert.equal(error.detail.expected, testCase.expected, testCase.name);
      assert.equal(error.detail.actual, testCase.actual, testCase.name);
      assert.equal(repository.invalidateCalls.length, 1, testCase.name);
      assert.deepEqual(
        repository.invalidateCalls[0]?.failure,
        projectTradeOpsError(error as TradeOpsError, [], false),
        testCase.name
      );
      assert.equal(repository.confirmCalls.length, 0, testCase.name);
      assert.equal(repository.record.state, 'PREFLIGHT_INVALIDATED', testCase.name);
      assertPreflightReads(context, FULL_PREFLIGHT_READS, testCase.name);
      assert.equal(context.spot.createdRequests.length, 0, testCase.name);
      assert.equal(context.contract.createdRequests.length, 0, testCase.name);
      assert.deepEqual(repository.forbiddenCalls, [], testCase.name);
      assertLockAvailable(strategyId);
    }

    t.after(() => {
      for (const strategyId of strategyIds) releaseStrategyOperation(strategyId);
    });
  }
);
