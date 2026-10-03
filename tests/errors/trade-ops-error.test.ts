/// <reference types="node" />

import assert from 'node:assert/strict';
import test from 'node:test';

const ERROR_MODULE_SPECIFIER = '../../src/errors/trade-ops-error.js';

type ErrorPhase =
  | 'startup'
  | 'request'
  | 'preflight'
  | 'confirmation'
  | 'storage';
type SafeDiagnosticValue = string | number | boolean | null | readonly string[];
type ErrorSubject = Readonly<Record<string, unknown>> & { readonly type: string };

interface ErrorInput {
  readonly code: string;
  readonly phase: ErrorPhase;
  readonly subject: ErrorSubject;
  readonly expected: SafeDiagnosticValue;
  readonly actual: SafeDiagnosticValue;
  readonly occurredAt?: string;
}

interface ErrorDetail {
  readonly code: string;
  readonly phase: ErrorPhase;
  readonly subject: ErrorSubject;
  readonly expected: SafeDiagnosticValue;
  readonly actual: SafeDiagnosticValue;
  readonly message: string;
  readonly occurredAt: string;
}

type TradeOpsErrorLike = Error & { readonly detail: ErrorDetail };

interface ErrorContractModule {
  readonly TradeOpsError: abstract new (...args: never[]) => TradeOpsErrorLike;
  readonly createTradeOpsError: (
    input: unknown,
    secrets?: readonly string[]
  ) => TradeOpsErrorLike;
  readonly withErrorPhase: (
    error: TradeOpsErrorLike,
    phase: ErrorPhase
  ) => TradeOpsErrorLike;
  readonly parseErrorDetail: (value: unknown) => ErrorDetail;
  readonly safeFailureCategory: (error: unknown) => string;
}

const ALL_ERROR_CODES = [
  'CONFIG_FIELD_MISSING',
  'CONFIG_FIELD_INVALID',
  'DATABASE_OPEN_FAILED',
  'DATABASE_SCHEMA_VERSION_MISMATCH',
  'DATABASE_OWNERSHIP_BUSY',
  'DATABASE_OWNERSHIP_UNAVAILABLE',
  'SERVICE_COMPONENT_FAILED',
  'SERVICE_LISTEN_FAILED',
  'REQUEST_FORBIDDEN',
  'REQUEST_BODY_INVALID',
  'REQUEST_FIELD_INVALID',
  'STRATEGY_NOT_FOUND',
  'STRATEGY_STATE_MISMATCH',
  'STRATEGY_OPERATION_BUSY',
  'EXCHANGE_NOT_CONFIGURED',
  'MARKET_UNAVAILABLE',
  'MARKET_IDENTITY_MISMATCH',
  'MARKET_INACTIVE',
  'MARKET_RULE_INVALID',
  'ACCOUNT_SETTINGS_UNAVAILABLE',
  'ACCOUNT_SETTINGS_CONFLICT',
  'ACCOUNT_POSITION_MODE_MISMATCH',
  'ACCOUNT_MARGIN_MODE_MISMATCH',
  'ACCOUNT_LEVERAGE_MISMATCH',
  'QUANTITY_INVALID',
  'QUANTITY_NOT_REPRESENTABLE',
  'QUANTITY_OUT_OF_RANGE',
  'PRICE_UNAVAILABLE',
  'PRICE_INVALID',
  'NOTIONAL_OUT_OF_RANGE',
  'BALANCE_UNAVAILABLE',
  'BALANCE_INSUFFICIENT',
  'PREFLIGHT_INVALIDATED',
  'STORAGE_OPERATION_FAILED',
  'STORAGE_RECORD_INVALID',
  'STORAGE_TRANSITION_REJECTED'
] as const;

const SUBJECT_BY_CODE: Readonly<Record<string, ErrorSubject>> = {
  CONFIG_FIELD_MISSING: { type: 'configuration', field: 'PORT' },
  CONFIG_FIELD_INVALID: { type: 'configuration', field: 'PORT' },
  DATABASE_OPEN_FAILED: {
    type: 'database', path: '/tmp/synthetic.db', operation: 'open'
  },
  DATABASE_SCHEMA_VERSION_MISMATCH: {
    type: 'database', table: 'schema_version', field: 'version'
  },
  DATABASE_OWNERSHIP_BUSY: {
    type: 'database', path: '/tmp/synthetic.db', operation: 'claim-ownership'
  },
  DATABASE_OWNERSHIP_UNAVAILABLE: {
    type: 'database', path: '/tmp/synthetic.db', operation: 'claim-ownership'
  },
  SERVICE_COMPONENT_FAILED: {
    type: 'configuration', field: 'recoveryMonitor'
  },
  SERVICE_LISTEN_FAILED: { type: 'configuration', field: 'listenAddress' },
  REQUEST_FORBIDDEN: { type: 'request', field: 'origin' },
  REQUEST_BODY_INVALID: { type: 'request', field: 'body' },
  REQUEST_FIELD_INVALID: { type: 'request', field: 'requestedBaseQuantity' },
  STRATEGY_NOT_FOUND: { type: 'strategy', strategyId: 'strategy-test' },
  STRATEGY_STATE_MISMATCH: {
    type: 'strategy', strategyId: 'strategy-test', field: 'state'
  },
  STRATEGY_OPERATION_BUSY: {
    type: 'strategy', strategyId: 'strategy-test', field: 'operationLock'
  },
  EXCHANGE_NOT_CONFIGURED: {
    type: 'exchange', exchangeId: 'okx', operation: 'preflight'
  },
  MARKET_UNAVAILABLE: {
    type: 'market', exchangeId: 'okx', symbol: 'BTC/USDT:USDT', kind: 'swap'
  },
  MARKET_IDENTITY_MISMATCH: {
    type: 'market', exchangeId: 'okx', symbol: 'BTC/USDT:USDT', kind: 'swap',
    field: 'identity'
  },
  MARKET_INACTIVE: {
    type: 'market', exchangeId: 'okx', symbol: 'BTC/USDT:USDT', kind: 'swap',
    field: 'active'
  },
  MARKET_RULE_INVALID: {
    type: 'market', exchangeId: 'okx', symbol: 'BTC/USDT:USDT', kind: 'swap',
    field: 'amountPrecision'
  },
  ACCOUNT_SETTINGS_UNAVAILABLE: {
    type: 'account', exchangeId: 'okx', symbol: 'BTC/USDT:USDT',
    field: 'settings'
  },
  ACCOUNT_SETTINGS_CONFLICT: {
    type: 'account', exchangeId: 'okx', symbol: 'BTC/USDT:USDT',
    field: 'marginMode'
  },
  ACCOUNT_POSITION_MODE_MISMATCH: {
    type: 'account', exchangeId: 'okx', symbol: 'BTC/USDT:USDT',
    field: 'positionMode'
  },
  ACCOUNT_MARGIN_MODE_MISMATCH: {
    type: 'account', exchangeId: 'okx', symbol: 'BTC/USDT:USDT',
    field: 'marginMode'
  },
  ACCOUNT_LEVERAGE_MISMATCH: {
    type: 'account', exchangeId: 'okx', symbol: 'BTC/USDT:USDT',
    field: 'leverage'
  },
  QUANTITY_INVALID: {
    type: 'market', exchangeId: 'okx', symbol: 'BTC/USDT:USDT', kind: 'swap',
    field: 'quantity'
  },
  QUANTITY_NOT_REPRESENTABLE: {
    type: 'market', exchangeId: 'okx', symbol: 'BTC/USDT:USDT', kind: 'swap',
    field: 'amountPrecision'
  },
  QUANTITY_OUT_OF_RANGE: {
    type: 'market', exchangeId: 'okx', symbol: 'BTC/USDT:USDT', kind: 'swap',
    field: 'amount'
  },
  PRICE_UNAVAILABLE: {
    type: 'market', exchangeId: 'okx', symbol: 'BTC/USDT:USDT', kind: 'swap',
    field: 'price'
  },
  PRICE_INVALID: {
    type: 'market', exchangeId: 'okx', symbol: 'BTC/USDT:USDT', kind: 'swap',
    field: 'price'
  },
  NOTIONAL_OUT_OF_RANGE: {
    type: 'market', exchangeId: 'okx', symbol: 'BTC/USDT:USDT', kind: 'swap',
    field: 'notional'
  },
  BALANCE_UNAVAILABLE: {
    type: 'account', exchangeId: 'bitget', symbol: 'BTC/USDT', field: 'balance'
  },
  BALANCE_INSUFFICIENT: {
    type: 'account', exchangeId: 'bitget', symbol: 'BTC/USDT', field: 'balance'
  },
  PREFLIGHT_INVALIDATED: {
    type: 'strategy', strategyId: 'strategy-test', field: 'preflight'
  },
  STORAGE_OPERATION_FAILED: {
    type: 'database', table: 'strategies', operation: 'update'
  },
  STORAGE_RECORD_INVALID: {
    type: 'database', table: 'strategies', recordId: 'strategy-test'
  },
  STORAGE_TRANSITION_REJECTED: {
    type: 'strategy', strategyId: 'strategy-test', field: 'state'
  }
};

function phaseForCode(code: string): ErrorPhase {
  if (
    code.startsWith('CONFIG_')
    || code.startsWith('DATABASE_')
    || code.startsWith('SERVICE_')
  ) {
    return 'startup';
  }
  if (
    code.startsWith('REQUEST_')
    || code === 'STRATEGY_NOT_FOUND'
    || code === 'STRATEGY_STATE_MISMATCH'
    || code === 'STRATEGY_OPERATION_BUSY'
  ) {
    return 'request';
  }
  if (code === 'PREFLIGHT_INVALIDATED') {
    return 'confirmation';
  }
  if (code.startsWith('STORAGE_')) {
    return 'storage';
  }
  return 'preflight';
}

function baseInput(overrides: Partial<ErrorInput> = {}): ErrorInput {
  return {
    code: 'REQUEST_FIELD_INVALID',
    phase: 'request',
    subject: { type: 'request', field: 'requestedBaseQuantity' },
    expected: 'positive decimal string',
    actual: 'zero',
    ...overrides
  };
}

function assertRejectsSynchronously(
  call: () => unknown,
  forbiddenText: readonly string[] = []
): unknown {
  let didThrow = false;
  let thrown: unknown;
  try {
    call();
  } catch (error) {
    didThrow = true;
    thrown = error;
  }
  assert.equal(didThrow, true, 'expected the unsafe value to be rejected');
  const rendered = (() => {
    try {
      return String(thrown);
    } catch {
      return '';
    }
  })();
  for (const forbidden of forbiddenText) {
    assert.equal(
      rendered.includes(forbidden),
      false,
      'rejection text must not expose untrusted or secret input'
    );
  }
  return thrown;
}

function assertSafeCategory(value: unknown): string {
  if (typeof value !== 'string') {
    assert.fail('safe category must be a string');
  }
  assert.ok(value.length > 0, 'safe category must be non-empty');
  return value;
}

async function loadContract(): Promise<ErrorContractModule> {
  let loaded: unknown;
  try {
    loaded = await import(ERROR_MODULE_SPECIFIER);
  } catch {
    assert.fail(
      '缺少可信精确错误契约能力：src/errors/trade-ops-error.ts 尚不可加载'
    );
  }

  assert.equal(typeof loaded, 'object');
  assert.notEqual(loaded, null);
  const candidate = loaded as Partial<ErrorContractModule>;
  for (const exportName of [
    'TradeOpsError',
    'createTradeOpsError',
    'withErrorPhase',
    'parseErrorDetail',
    'safeFailureCategory'
  ] as const) {
    assert.equal(
      typeof candidate[exportName],
      'function',
      `缺少可信精确错误契约导出：${exportName}`
    );
  }
  return candidate as ErrorContractModule;
}

test('可信精确错误契约', async (t) => {
  const contract = await loadContract();

  await t.test('所有闭合错误码都生成含中文与本次字段证据的消息', () => {
    const messages: string[] = [];
    for (const code of ALL_ERROR_CODES) {
      const subject = SUBJECT_BY_CODE[code];
      if (subject === undefined) {
        assert.fail(`missing subject fixture for ${code}`);
      }
      const error = contract.createTradeOpsError(baseInput({
        code,
        phase: phaseForCode(code),
        subject,
        expected: '期望证据',
        actual: '实际证据'
      }));

      assert.ok(error instanceof Error);
      assert.ok(error instanceof contract.TradeOpsError);
      assert.equal(error.detail.code, code);
      assert.match(error.detail.message, /[\u3400-\u9fff]/u);
      assert.match(error.detail.message, /期望证据/u);
      assert.match(error.detail.message, /实际证据/u);
      assert.equal(error.message, error.detail.message);
      assert.deepEqual(
        Object.keys(error.detail).sort(),
        ['actual', 'code', 'expected', 'message', 'occurredAt', 'phase', 'subject']
      );
      assert.equal('cause' in error.detail, false);
      assert.equal('stack' in error.detail, false);
      messages.push(error.detail.message);
    }
    assert.equal(messages.length, ALL_ERROR_CODES.length);
    assert.equal(new Set(messages).size, ALL_ERROR_CODES.length);
  });

  await t.test('动态消息字符串编码无歧义且不保留原始控制字符', () => {
    const subjectCases: readonly ErrorSubject[] = [
      { type: 'configuration', field: '配置」，"quoted"\nline' },
      { type: 'request', field: '请求」，"quoted"\nline' },
      {
        type: 'exchange', exchangeId: '交易所」，"quoted"\nline',
        operation: '操作」，"quoted"\nline'
      },
      {
        type: 'market', exchangeId: '市场交易所」，"quoted"\nline',
        symbol: 'BTC/USDT」，"quoted"\nline', kind: '类型」，"quoted"\nline',
        field: '字段」，"quoted"\nline'
      },
      {
        type: 'account', exchangeId: '账户交易所」，"quoted"\nline',
        symbol: 'ETH/USDT」，"quoted"\nline', field: '账户字段」，"quoted"\nline'
      },
      {
        type: 'strategy', strategyId: '策略」，"quoted"\nline',
        field: '策略字段」，"quoted"\nline'
      },
      {
        type: 'database', path: '/tmp/路径」，"quoted"\nline',
        table: '表」，"quoted"\nline', recordId: '记录」，"quoted"\nline',
        field: '库字段」，"quoted"\nline', operation: '库操作」，"quoted"\nline'
      }
    ];
    for (const subject of subjectCases) {
      const detail = contract.createTradeOpsError(baseInput({
        subject,
        expected: '期望」，实际为 字符串「值，"quoted"\nline',
        actual: ['实际」，期望 字符串「值，"quoted"\nline']
      })).detail;
      for (const [key, value] of Object.entries(subject)) {
        if (key !== 'type' && typeof value === 'string') {
          assert.ok(detail.message.includes(JSON.stringify(value)));
        }
      }
      assert.ok(detail.message.includes(JSON.stringify(detail.expected)));
      assert.ok(detail.message.includes(JSON.stringify(detail.actual)));
      assert.equal(/[\u0000-\u001f]/u.test(detail.message), false);
    }

    const diagnosticCollisionA = contract.createTradeOpsError(baseInput({
      expected: 'x」，实际为 字符串「y', actual: 'z'
    })).message;
    const diagnosticCollisionB = contract.createTradeOpsError(baseInput({
      expected: 'x', actual: 'y」，实际为 字符串「z'
    })).message;
    assert.notEqual(diagnosticCollisionA, diagnosticCollisionB);

    const subjectCollisionA = contract.createTradeOpsError(baseInput({
      code: 'EXCHANGE_NOT_CONFIGURED',
      subject: { type: 'exchange', exchangeId: 'x」操作「y', operation: 'z' }
    })).message;
    const subjectCollisionB = contract.createTradeOpsError(baseInput({
      code: 'EXCHANGE_NOT_CONFIGURED',
      subject: { type: 'exchange', exchangeId: 'x', operation: 'y」操作「z' }
    })).message;
    assert.notEqual(subjectCollisionA, subjectCollisionB);
  });

  await t.test('消息编码不得由真实换行合成显式秘密', () => {
    const secret = String.raw`\n`;
    const expected = 'line one\nline two';
    assert.equal(expected.includes(secret), false);

    assertRejectsSynchronously(() => contract.createTradeOpsError(baseInput({
      expected
    }), [secret]), [secret]);
  });

  await t.test('消息编码不得由普通双引号合成显式秘密', () => {
    const secret = String.raw`\"`;
    const expected = 'quoted "value"';
    assert.equal(expected.includes(secret), false);

    assertRejectsSynchronously(() => contract.createTradeOpsError(baseInput({
      expected
    }), [secret]), [secret]);
  });

  await t.test('保留七种异构对象和全部安全诊断值而不改变数值精度', () => {
    const cases: readonly {
      code: string;
      subject: ErrorSubject;
      expected: SafeDiagnosticValue;
      actual: SafeDiagnosticValue;
    }[] = [
      {
        code: 'CONFIG_FIELD_INVALID',
        subject: { type: 'configuration', field: 'PORT' },
        expected: 'integer in range',
        actual: 'not-an-integer'
      },
      {
        code: 'REQUEST_FIELD_INVALID',
        subject: { type: 'request', field: 'mode' },
        expected: ['SPOT_FIRST', 'CONTRACT_FIRST'],
        actual: 'unknown'
      },
      {
        code: 'EXCHANGE_NOT_CONFIGURED',
        subject: { type: 'exchange', exchangeId: 'okx', operation: 'preflight' },
        expected: true,
        actual: false
      },
      {
        code: 'MARKET_RULE_INVALID',
        subject: {
          type: 'market', exchangeId: 'okx', symbol: 'BTC/USDT:USDT',
          kind: 'swap', field: 'contractSize'
        },
        expected: 0.125,
        actual: 0.1
      },
      {
        code: 'ACCOUNT_SETTINGS_UNAVAILABLE',
        subject: {
          type: 'account', exchangeId: 'okx', symbol: 'BTC/USDT:USDT',
          field: 'settings'
        },
        expected: 'available',
        actual: null
      },
      {
        code: 'STRATEGY_STATE_MISMATCH',
        subject: { type: 'strategy', strategyId: 'strategy-test', field: 'state' },
        expected: 'PENDING_CONFIRMATION',
        actual: 'EXECUTING'
      },
      {
        code: 'STORAGE_OPERATION_FAILED',
        subject: {
          type: 'database', path: '/tmp/synthetic.db', table: 'strategies',
          recordId: 'strategy-test', field: 'state', operation: 'update'
        },
        expected: 'one row updated',
        actual: 'no rows updated'
      }
    ];

    for (const fixture of cases) {
      const detail = contract.createTradeOpsError(baseInput(fixture)).detail;
      assert.deepEqual(detail.subject, fixture.subject);
      assert.deepEqual(detail.expected, fixture.expected);
      assert.deepEqual(detail.actual, fixture.actual);
    }
  });

  await t.test('对输入拍不可变快照且不受调用方后续修改影响', () => {
    const subject: Record<string, unknown> = {
      type: 'market', exchangeId: 'okx', symbol: 'BTC/USDT:USDT', kind: 'swap',
      field: 'limits'
    };
    const expected = ['minimum', 'maximum'];
    const input = baseInput({
      code: 'MARKET_RULE_INVALID',
      phase: 'preflight',
      subject: subject as ErrorSubject,
      expected,
      actual: 'missing',
      occurredAt: '2026-10-02T08:09:10.123Z'
    });

    const error = contract.createTradeOpsError(input);
    subject.symbol = 'MUTATED/SECRET';
    expected[0] = 'mutated';

    assert.equal(error.detail.subject.symbol, 'BTC/USDT:USDT');
    assert.deepEqual(error.detail.expected, ['minimum', 'maximum']);
    assert.equal(error.detail.occurredAt, '2026-10-02T08:09:10.123Z');
    assert.equal(Object.isFrozen(error.detail), true);
    assert.equal(Object.isFrozen(error.detail.subject), true);
    assert.equal(Object.isFrozen(error.detail.expected), true);
    assert.throws(() => {
      (error.detail.subject as Record<string, unknown>).symbol = 'changed';
    }, TypeError);
  });

  await t.test('自动时间戳可持久化并由解析器接受', () => {
    const detail = contract.createTradeOpsError(baseInput()).detail;
    assert.match(
      detail.occurredAt,
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u
    );
    assert.deepEqual(contract.parseErrorDetail(structuredClone(detail)), detail);
  });

  await t.test('阶段转换保留发生时间与诊断证据且不修改原错误', () => {
    const original = contract.createTradeOpsError(baseInput({
      phase: 'preflight',
      occurredAt: '2026-10-02T08:09:10.123Z'
    }));
    const shifted = contract.withErrorPhase(original, 'confirmation');

    assert.notEqual(shifted, original);
    assert.ok(shifted instanceof contract.TradeOpsError);
    assert.equal(original.detail.phase, 'preflight');
    assert.equal(shifted.detail.phase, 'confirmation');
    assert.equal(shifted.detail.occurredAt, original.detail.occurredAt);
    assert.equal(shifted.detail.code, original.detail.code);
    assert.deepEqual(shifted.detail.subject, original.detail.subject);
    assert.deepEqual(shifted.detail.expected, original.detail.expected);
    assert.deepEqual(shifted.detail.actual, original.detail.actual);
    assert.doesNotThrow(() => contract.parseErrorDetail(shifted.detail));
  });

  await t.test('显式提供的合成秘密不会进入结构字段或消息', () => {
    const secret = 'synthetic-secret-value';
    const error = contract.createTradeOpsError(baseInput({
      subject: { type: 'request', field: `token-${secret}` },
      expected: `prefix-${secret}-suffix`,
      actual: [`first-${secret}`, 'safe']
    }), [secret]);
    const serialized = JSON.stringify(error.detail);

    assert.equal(serialized.includes(secret), false);
    assert.equal(error.message.includes(secret), false);
    assert.equal(typeof error.detail.expected, 'string');
    assert.ok(Array.isArray(error.detail.actual));
  });

  await t.test('秘密与替换文本重叠时不会被替换结果重新引入', () => {
    const secret = '已';
    const error = contract.createTradeOpsError(baseInput({
      expected: `prefix-${secret}-suffix`
    }), [secret]);

    assert.equal(JSON.stringify(error.detail).includes(secret), false);
  });

  await t.test('凭证字段只接受 missing 或 present-but-invalid', () => {
    for (const fixture of [
      { code: 'CONFIG_FIELD_MISSING', actual: 'missing' },
      { code: 'CONFIG_FIELD_INVALID', actual: 'present-but-invalid' }
    ] as const) {
      const detail = contract.createTradeOpsError(baseInput({
        code: fixture.code,
        phase: 'startup',
        subject: { type: 'configuration', field: 'TRADING_OKX_SECRET' },
        expected: 'configured credential',
        actual: fixture.actual
      })).detail;
      assert.equal(detail.actual, fixture.actual);
    }

    const secret = 'synthetic-credential-secret';
    assertRejectsSynchronously(() => contract.createTradeOpsError(baseInput({
      code: 'CONFIG_FIELD_INVALID',
      phase: 'startup',
      subject: { type: 'configuration', field: 'TRADING_OKX_SECRET' },
      expected: 'configured credential',
      actual: secret
    }), [secret]), [secret]);
  });

  await t.test('凭证字段和实际类别必须在脱敏前完成判定', () => {
    const secret = 'SECRET';
    for (const actual of [
      secret,
      `missing${secret}`,
      `present-but-invalid${secret}`
    ]) {
      assertRejectsSynchronously(() => contract.createTradeOpsError(baseInput({
        code: 'CONFIG_FIELD_INVALID',
        phase: 'startup',
        subject: { type: 'configuration', field: 'TRADING_OKX_SECRET' },
        expected: 'configured credential',
        actual
      }), [secret]), [secret]);
    }

    assertRejectsSynchronously(() => contract.createTradeOpsError(baseInput({
      code: 'CONFIG_FIELD_INVALID',
      phase: 'startup',
      subject: { type: 'configuration', field: 'TRADING_OKX_SECRET' },
      expected: 'configured credential',
      actual: 'missing'
    }), ['missing']), ['missing']);
  });

  await t.test('标识、symbol 与 path 在上限处接受并在越界时拒绝', () => {
    const identifierCases: readonly {
      label: string;
      make: (value: string) => Partial<ErrorInput>;
    }[] = [
      {
        label: 'configuration.field',
        make: (field) => ({
          code: 'CONFIG_FIELD_INVALID',
          subject: { type: 'configuration', field }
        })
      },
      {
        label: 'request.field',
        make: (field) => ({ subject: { type: 'request', field } })
      },
      {
        label: 'exchange.exchangeId',
        make: (exchangeId) => ({
          code: 'EXCHANGE_NOT_CONFIGURED',
          subject: { type: 'exchange', exchangeId, operation: 'preflight' }
        })
      },
      {
        label: 'exchange.operation',
        make: (operation) => ({
          code: 'EXCHANGE_NOT_CONFIGURED',
          subject: { type: 'exchange', exchangeId: 'okx', operation }
        })
      },
      {
        label: 'market.kind',
        make: (kind) => ({
          code: 'MARKET_RULE_INVALID',
          subject: {
            type: 'market', exchangeId: 'okx', symbol: 'BTC/USDT:USDT', kind
          }
        })
      },
      {
        label: 'market.field',
        make: (field) => ({
          code: 'MARKET_RULE_INVALID',
          subject: {
            type: 'market', exchangeId: 'okx', symbol: 'BTC/USDT:USDT',
            kind: 'swap', field
          }
        })
      },
      {
        label: 'account.field',
        make: (field) => ({
          code: 'ACCOUNT_SETTINGS_CONFLICT',
          subject: {
            type: 'account', exchangeId: 'okx', symbol: 'BTC/USDT:USDT', field
          }
        })
      },
      {
        label: 'strategy.strategyId',
        make: (strategyId) => ({
          code: 'STRATEGY_STATE_MISMATCH',
          subject: { type: 'strategy', strategyId, field: 'state' }
        })
      },
      {
        label: 'strategy.field',
        make: (field) => ({
          code: 'STRATEGY_STATE_MISMATCH',
          subject: { type: 'strategy', strategyId: 'strategy-test', field }
        })
      },
      ...(['table', 'recordId', 'field', 'operation'] as const).map((key) => ({
        label: `database.${key}`,
        make: (value: string): Partial<ErrorInput> => ({
          code: 'STORAGE_OPERATION_FAILED',
          phase: 'storage',
          subject: { type: 'database', [key]: value }
        })
      }))
    ];

    for (const fixture of identifierCases) {
      assert.doesNotThrow(
        () => contract.createTradeOpsError(baseInput(fixture.make('i'.repeat(128)))),
        `${fixture.label} should accept 128 characters`
      );
      assertRejectsSynchronously(
        () => contract.createTradeOpsError(baseInput(fixture.make('i'.repeat(129))))
      );
    }

    for (const fixture of [
      {
        code: 'MARKET_RULE_INVALID',
        makeSubject: (symbol: string): ErrorSubject => ({
          type: 'market', exchangeId: 'okx', symbol, kind: 'swap'
        })
      },
      {
        code: 'ACCOUNT_SETTINGS_CONFLICT',
        makeSubject: (symbol: string): ErrorSubject => ({
          type: 'account', exchangeId: 'okx', symbol, field: 'settings'
        })
      }
    ]) {
      assert.doesNotThrow(() => contract.createTradeOpsError(baseInput({
        code: fixture.code, subject: fixture.makeSubject('s'.repeat(64))
      })));
      assertRejectsSynchronously(() => contract.createTradeOpsError(baseInput({
        code: fixture.code, subject: fixture.makeSubject('s'.repeat(65))
      })));
    }

    assert.doesNotThrow(() => contract.createTradeOpsError(baseInput({
      code: 'DATABASE_OPEN_FAILED',
      phase: 'startup',
      subject: { type: 'database', path: 'p'.repeat(512), operation: 'open' }
    })));
    assertRejectsSynchronously(() => contract.createTradeOpsError(baseInput({
      code: 'DATABASE_OPEN_FAILED',
      phase: 'startup',
      subject: { type: 'database', path: 'p'.repeat(513), operation: 'open' }
    })));
  });

  await t.test('诊断字符串、列表项与列表项数严格执行闭区间边界', () => {
    assert.doesNotThrow(() => contract.createTradeOpsError(baseInput({
      expected: 'e'.repeat(2_000),
      actual: Array.from({ length: 16 }, () => 'a'.repeat(2_000))
    })));
    assertRejectsSynchronously(() => contract.createTradeOpsError(baseInput({
      expected: 'e'.repeat(2_001)
    })));
    assertRejectsSynchronously(() => contract.createTradeOpsError(baseInput({
      actual: Array.from({ length: 17 }, () => 'safe')
    })));
    assertRejectsSynchronously(() => contract.createTradeOpsError(baseInput({
      actual: ['a'.repeat(2_001)]
    })));
  });

  await t.test('脱敏不得使原始越界字符串通过长度校验', () => {
    const secret = 'S';
    const inputs: readonly ErrorInput[] = [
      baseInput({
        subject: { type: 'request', field: `${'i'.repeat(128)}${secret}` }
      }),
      baseInput({
        code: 'MARKET_RULE_INVALID',
        subject: {
          type: 'market', exchangeId: 'okx',
          symbol: `${'s'.repeat(64)}${secret}`, kind: 'swap'
        }
      }),
      baseInput({
        code: 'DATABASE_OPEN_FAILED', phase: 'startup',
        subject: {
          type: 'database', path: `${'p'.repeat(512)}${secret}`, operation: 'open'
        }
      }),
      baseInput({ expected: `${'e'.repeat(2_000)}${secret}` }),
      baseInput({ actual: [`${'a'.repeat(2_000)}${secret}`] })
    ];

    for (const input of inputs) {
      assertRejectsSynchronously(
        () => contract.createTradeOpsError(input, [secret]),
        [secret]
      );
    }
  });

  await t.test('拒绝非有限数字、对象及非字符串列表项', () => {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      assertRejectsSynchronously(() => contract.createTradeOpsError(baseInput({
        actual: value
      })));
    }
    for (const value of [{ raw: 'third-party' }, ['safe', 1], new Date(0)]) {
      assertRejectsSynchronously(() => contract.createTradeOpsError({
        ...baseInput(), actual: value
      }));
    }
  });

  await t.test('拒绝未知码、未知阶段、未知对象变体和缺失必填字段', () => {
    for (const unsafeInput of [
      { ...baseInput(), code: 'NOT_A_TRADE_OPS_CODE' },
      { ...baseInput(), phase: 'execution' },
      { ...baseInput(), subject: { type: 'unknown', field: 'state' } },
      { ...baseInput(), subject: { type: 'request' } },
      {
        ...baseInput(), code: 'EXCHANGE_NOT_CONFIGURED',
        subject: { type: 'exchange', exchangeId: 'okx' }
      },
      {
        ...baseInput(), code: 'MARKET_RULE_INVALID',
        subject: { type: 'market', exchangeId: 'okx', kind: 'swap' }
      },
      {
        ...baseInput(), code: 'ACCOUNT_SETTINGS_CONFLICT',
        subject: { type: 'account', exchangeId: 'okx', symbol: 'BTC/USDT:USDT' }
      },
      {
        ...baseInput(), code: 'STRATEGY_STATE_MISMATCH',
        subject: { type: 'strategy', field: 'state' }
      },
      {
        code: 'REQUEST_FIELD_INVALID', phase: 'request',
        subject: { type: 'request', field: 'mode' }, actual: 'bad'
      }
    ]) {
      assertRejectsSynchronously(() => contract.createTradeOpsError(unsafeInput));
    }
  });

  await t.test('拒绝输入和每种对象变体的额外字段', () => {
    assertRejectsSynchronously(() => contract.createTradeOpsError({
      ...baseInput(), unexpected: 'unsafe'
    }));

    const subjects = [
      { type: 'configuration', field: 'PORT' },
      { type: 'request', field: 'mode' },
      { type: 'exchange', exchangeId: 'okx', operation: 'preflight' },
      { type: 'market', exchangeId: 'okx', symbol: 'BTC/USDT:USDT', kind: 'swap' },
      {
        type: 'account', exchangeId: 'okx', symbol: 'BTC/USDT:USDT',
        field: 'positionMode'
      },
      { type: 'strategy', strategyId: 'strategy-test' },
      { type: 'database', table: 'strategies' }
    ];
    for (const subject of subjects) {
      assertRejectsSynchronously(() => contract.createTradeOpsError(baseInput({
        subject: { ...subject, unexpected: 'unsafe' }
      })));
    }
  });

  await t.test('拒绝访问器而不读取其中的合成秘密', () => {
    const secret = 'synthetic-getter-secret';
    let reads = 0;
    const input = { ...baseInput() } as Record<string, unknown>;
    Object.defineProperty(input, 'actual', {
      enumerable: true,
      get(): string {
        reads += 1;
        return secret;
      }
    });
    assertRejectsSynchronously(
      () => contract.createTradeOpsError(input),
      [secret]
    );
    assert.equal(reads, 0);

    const subject: Record<string, unknown> = { type: 'request' };
    Object.defineProperty(subject, 'field', {
      enumerable: true,
      get(): string {
        reads += 1;
        return secret;
      }
    });
    assertRejectsSynchronously(
      () => contract.createTradeOpsError(baseInput({ subject: subject as ErrorSubject })),
      [secret]
    );
    assert.equal(reads, 0);

    const list: string[] = ['safe'];
    Object.defineProperty(list, '0', {
      enumerable: true,
      get(): string {
        reads += 1;
        return secret;
      }
    });
    assertRejectsSynchronously(
      () => contract.createTradeOpsError(baseInput({ actual: list })),
      [secret]
    );
    assert.equal(reads, 0);
  });

  await t.test('持久化解析重新校验并返回不受源对象修改影响的快照', () => {
    const source = structuredClone(contract.createTradeOpsError(baseInput({
      occurredAt: '2026-10-02T08:09:10.123Z'
    })).detail) as unknown as Record<string, unknown>;
    const parsed = contract.parseErrorDetail(source);
    (source.subject as Record<string, unknown>).field = 'mutated';

    assert.equal(parsed.subject.field, 'requestedBaseQuantity');
    assert.equal(Object.isFrozen(parsed), true);
    assert.equal(Object.isFrozen(parsed.subject), true);
  });

  await t.test('持久化解析拒绝伪造消息、字段漂移和额外属性', () => {
    const valid = structuredClone(contract.createTradeOpsError(baseInput({
      occurredAt: '2026-10-02T08:09:10.123Z'
    })).detail);
    assertRejectsSynchronously(() => contract.parseErrorDetail({
      ...valid, message: '伪造但看似安全的消息'
    }));
    assertRejectsSynchronously(() => contract.parseErrorDetail({
      ...valid, actual: 'different evidence'
    }));
    assertRejectsSynchronously(() => contract.parseErrorDetail({
      ...valid, unexpected: 'unsafe'
    }));
    assertRejectsSynchronously(() => contract.parseErrorDetail({
      ...valid, code: 'NOT_A_TRADE_OPS_CODE'
    }));
  });

  await t.test('持久化解析拒绝访问器且不读取原始载荷', () => {
    const secret = 'synthetic-storage-payload';
    let reads = 0;
    const stored = structuredClone(
      contract.createTradeOpsError(baseInput()).detail
    ) as unknown as Record<string, unknown>;
    Object.defineProperty(stored, 'message', {
      enumerable: true,
      get(): string {
        reads += 1;
        return secret;
      }
    });

    assertRejectsSynchronously(() => contract.parseErrorDetail(stored), [secret]);
    assert.equal(reads, 0);
  });

  await t.test('未知异常分类不信任任意 name、message 或 code', () => {
    const first = Object.assign(new Error('synthetic-message-one'), {
      name: 'SyntheticNameOne', code: 'SYNTHETIC_CODE_ONE'
    });
    const second = Object.assign(new Error('synthetic-message-two'), {
      name: 'SyntheticNameTwo', code: 'SYNTHETIC_CODE_TWO'
    });
    const firstCategory = assertSafeCategory(contract.safeFailureCategory(first));
    const secondCategory = assertSafeCategory(contract.safeFailureCategory(second));

    assert.equal(firstCategory, secondCategory);
    assert.doesNotMatch(
      firstCategory,
      /SyntheticName|synthetic-message|SYNTHETIC_CODE/u
    );
  });

  await t.test('未知异常分类不调用 getter 且恶意 Proxy 不能改变业务结果', () => {
    const secret = 'synthetic-hostile-error';
    let reads = 0;
    const hostile: Record<string, unknown> = {};
    for (const property of ['name', 'message', 'code']) {
      Object.defineProperty(hostile, property, {
        enumerable: true,
        get(): never {
          reads += 1;
          throw new Error(secret);
        }
      });
    }
    const getterCategory = assertSafeCategory(
      contract.safeFailureCategory(hostile)
    );
    assert.equal(reads, 0);
    assert.equal(getterCategory.includes(secret), false);

    const proxy = new Proxy({}, {
      get(): never {
        reads += 1;
        throw new Error(secret);
      }
    });
    const proxyCategory = assertSafeCategory(contract.safeFailureCategory(proxy));
    assert.equal(reads, 0);
    assert.equal(proxyCategory.includes(secret), false);

    const revocable = Proxy.revocable({}, {});
    revocable.revoke();
    assert.doesNotThrow(() => contract.safeFailureCategory(revocable.proxy));
    assertSafeCategory(contract.safeFailureCategory(revocable.proxy));
  });

  await t.test('未知原始抛出值只产生类别而不透传内容', () => {
    const secret = 'synthetic-primitive-secret';
    for (const thrown of [secret, Symbol(secret), 42, true, null, undefined]) {
      const category = assertSafeCategory(contract.safeFailureCategory(thrown));
      assert.equal(category.includes(secret), false);
    }
    assert.equal(
      contract.safeFailureCategory('first raw failure'),
      contract.safeFailureCategory('second raw failure')
    );
  });
});
