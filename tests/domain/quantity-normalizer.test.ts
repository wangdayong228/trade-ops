/// <reference types="node" />

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  baseStepFor,
  normalizeCommonBaseQuantity,
  type CommonQuantityInput
} from '../../src/domain/quantity-normalizer.js';

interface ExpectedNormalizationFailure {
  readonly field: string;
  readonly expected: RegExp;
  readonly actual: string;
  readonly hasCause?: boolean;
}

function reportsNormalizationFailure(
  input: CommonQuantityInput,
  expected: ExpectedNormalizationFailure
): () => void {
  return () => {
    assert.throws(
      () => normalizeCommonBaseQuantity(input),
      (error: unknown) => {
        assert(error instanceof Error);
        const failure = error as Error & {
          readonly field?: unknown;
          readonly expected?: unknown;
          readonly actual?: unknown;
          readonly cause?: unknown;
        };
        assert.equal(failure.field, expected.field);
        assert.match(String(failure.expected), expected.expected);
        assert.equal(String(failure.actual), expected.actual);
        if (expected.hasCause === true) {
          assert(failure.cause instanceof Error);
        }
        return true;
      }
    );
  };
}

test('uses the least common multiple of both base-quantity steps', () => {
  // Hand calculation: LCM(0.002, 3 * 0.001) = 0.006, and floor(1 / 0.006) * 0.006 = 0.996.
  assert.equal(normalizeCommonBaseQuantity({
    requestedBaseQuantity: '1',
    spot: { amountStep: '0.002', contractSize: '1', minBaseAmount: '0.002' },
    swap: { amountStep: '3', contractSize: '0.001', minBaseAmount: '0.003' }
  }), '0.996');
});

test('converts amount steps from market units into base units', () => {
  assert.equal(baseStepFor({
    amountStep: '3',
    contractSize: '0.001',
    minBaseAmount: '0.003'
  }).toFixed(), '0.003');
});

test('rejects a derived base step that underflows to zero', () => {
  const underflowRules = {
    amountStep: '1e-5000000000000000',
    contractSize: '1e-5000000000000000',
    minBaseAmount: '0'
  };

  assert.throws(() => normalizeCommonBaseQuantity({
    requestedBaseQuantity: '1',
    spot: underflowRules,
    swap: { amountStep: '0.001', contractSize: '1', minBaseAmount: '0' }
  }), /spot\.baseStep/);
  assert.throws(() => baseStepFor(underflowRules), /baseStep/);
});

test('supports common steps with different decimal places', () => {
  assert.equal(normalizeCommonBaseQuantity({
    requestedBaseQuantity: '0.13',
    spot: { amountStep: '0.02', contractSize: '1', minBaseAmount: '0.02' },
    swap: { amountStep: '3', contractSize: '0.001', minBaseAmount: '0.003' }
  }), '0.12');
});

test('rounds requested base quantity down to the common step', () => {
  assert.equal(normalizeCommonBaseQuantity({
    requestedBaseQuantity: '0.0109',
    spot: { amountStep: '0.003', contractSize: '1', minBaseAmount: '0.003' },
    swap: { amountStep: '3', contractSize: '0.001', minBaseAmount: '0.003' }
  }), '0.009');
});

test('rejects a normalized amount below either market minimum', () => {
  assert.throws(() => normalizeCommonBaseQuantity({
    requestedBaseQuantity: '0.004',
    spot: { amountStep: '0.001', contractSize: '1', minBaseAmount: '0.005' },
    swap: { amountStep: '1', contractSize: '0.001', minBaseAmount: '0.001' }
  }), /minimum/);
});

for (const failureCase of [
  {
    name: 'zero after common-step alignment',
    input: {
      requestedBaseQuantity: '0.5',
      spot: { amountStep: '1', contractSize: '1', minBaseAmount: '0' },
      swap: { amountStep: '1', contractSize: '1', minBaseAmount: '0' }
    },
    expected: {
      field: 'effectiveQuantity',
      expected: /greater than zero/u,
      actual: '0'
    }
  },
  {
    name: 'spot minimum after alignment',
    input: {
      requestedBaseQuantity: '1.5',
      spot: { amountStep: '1', contractSize: '1', minBaseAmount: '1.5' },
      swap: { amountStep: '1', contractSize: '1', minBaseAmount: '0' }
    },
    expected: {
      field: 'spot.minBaseAmount',
      expected: /at least 1\.5/u,
      actual: '1'
    }
  },
  {
    name: 'swap minimum after alignment',
    input: {
      requestedBaseQuantity: '1.5',
      spot: { amountStep: '1', contractSize: '1', minBaseAmount: '0' },
      swap: { amountStep: '1', contractSize: '1', minBaseAmount: '1.5' }
    },
    expected: {
      field: 'swap.minBaseAmount',
      expected: /at least 1\.5/u,
      actual: '1'
    }
  },
  {
    name: 'swap minimum after upper clipping',
    input: {
      requestedBaseQuantity: '3',
      spot: {
        amountStep: '1',
        contractSize: '1',
        minBaseAmount: '0',
        maxBaseAmount: '1.5'
      },
      swap: { amountStep: '1', contractSize: '1', minBaseAmount: '2' }
    },
    expected: {
      field: 'swap.minBaseAmount',
      expected: /at least 2/u,
      actual: '1'
    }
  }
] satisfies ReadonlyArray<{
  readonly name: string;
  readonly input: CommonQuantityInput;
  readonly expected: ExpectedNormalizationFailure;
}>) {
  test(`reports ${failureCase.name} with its exact normalized value`,
    reportsNormalizationFailure(failureCase.input, failureCase.expected));
}

test('keeps the hand-calculated success boundary after common-step alignment', () => {
  assert.equal(normalizeCommonBaseQuantity({
    requestedBaseQuantity: '1.5',
    spot: { amountStep: '1', contractSize: '1', minBaseAmount: '1' },
    swap: { amountStep: '1', contractSize: '1', minBaseAmount: '1' }
  }), '1');
});

test('reports the required common scale and supported exact-arithmetic bound',
  reportsNormalizationFailure({
    requestedBaseQuantity: '1',
    spot: {
      amountStep: '1e-1000001',
      contractSize: '1',
      minBaseAmount: '0'
    },
    swap: { amountStep: '1', contractSize: '1', minBaseAmount: '0' }
  }, {
    field: 'commonStep',
    expected: /(?:at most|not exceed) 1000000/u,
    actual: '1000001'
  }));

test('reports a malformed rule value and preserves its decimal parse cause',
  reportsNormalizationFailure({
    requestedBaseQuantity: '1',
    spot: {
      amountStep: 'not-a-decimal',
      contractSize: '1',
      minBaseAmount: '0'
    },
    swap: { amountStep: '1', contractSize: '1', minBaseAmount: '0' }
  }, {
    field: 'spot.amountStep',
    expected: /decimal/u,
    actual: 'not-a-decimal',
    hasCause: true
  }));

for (const invalidRule of [
  { value: 'Infinity', expected: /finite.*greater than zero/u },
  { value: '0', expected: /finite.*greater than zero/u }
] as const) {
  test(`reports the actual invalid spot amount step ${invalidRule.value}`,
    reportsNormalizationFailure({
      requestedBaseQuantity: '1',
      spot: {
        amountStep: invalidRule.value,
        contractSize: '1',
        minBaseAmount: '0'
      },
      swap: { amountStep: '1', contractSize: '1', minBaseAmount: '0' }
    }, {
      field: 'spot.amountStep',
      expected: invalidRule.expected,
      actual: invalidRule.value
    }));
}

test('rejects non-finite, zero, and negative requested base quantities', () => {
  for (const requestedBaseQuantity of ['NaN', 'Infinity', '0', '-0.001']) {
    assert.throws(() => normalizeCommonBaseQuantity({
      requestedBaseQuantity,
      spot: { amountStep: '0.001', contractSize: '1', minBaseAmount: '0.001' },
      swap: { amountStep: '1', contractSize: '0.001', minBaseAmount: '0.001' }
    }), /requestedBaseQuantity/);
  }
});

test('rejects non-finite, zero, and negative amount steps and contract sizes', () => {
  const validRules = {
    amountStep: '0.001',
    contractSize: '1',
    minBaseAmount: '0.001'
  };

  for (const field of ['amountStep', 'contractSize'] as const) {
    for (const value of ['NaN', 'Infinity', '0', '-0.001']) {
      assert.throws(() => normalizeCommonBaseQuantity({
        requestedBaseQuantity: '1',
        spot: { ...validRules, [field]: value },
        swap: validRules
      }), new RegExp(field));
    }
  }
});

test('rejects invalid market minima and maxima', () => {
  const validRules = {
    amountStep: '0.001',
    contractSize: '1',
    minBaseAmount: '0.001'
  };
  const cases = [
    { rules: { ...validRules, minBaseAmount: 'NaN' }, field: 'minBaseAmount' },
    { rules: { ...validRules, minBaseAmount: '-0.001' }, field: 'minBaseAmount' },
    { rules: { ...validRules, maxBaseAmount: 'Infinity' }, field: 'maxBaseAmount' },
    { rules: { ...validRules, maxBaseAmount: '0' }, field: 'maxBaseAmount' }
  ];

  for (const { rules, field } of cases) {
    assert.throws(() => normalizeCommonBaseQuantity({
      requestedBaseQuantity: '1',
      spot: validRules,
      swap: rules
    }), new RegExp(field));
  }
});

test('accepts a zero market minimum', () => {
  assert.equal(normalizeCommonBaseQuantity({
    requestedBaseQuantity: '0.001',
    spot: { amountStep: '0.001', contractSize: '1', minBaseAmount: '0' },
    swap: { amountStep: '1', contractSize: '0.001', minBaseAmount: '0' }
  }), '0.001');
});

test('handles quantities just below, at, and just above the minimum', () => {
  const rules = {
    amountStep: '0.002',
    contractSize: '1',
    minBaseAmount: '0.004'
  };

  assert.throws(() => normalizeCommonBaseQuantity({
    requestedBaseQuantity: '0.003999',
    spot: rules,
    swap: rules
  }), /minimum/);
  assert.equal(normalizeCommonBaseQuantity({
    requestedBaseQuantity: '0.004',
    spot: rules,
    swap: rules
  }), '0.004');
  assert.equal(normalizeCommonBaseQuantity({
    requestedBaseQuantity: '0.004001',
    spot: rules,
    swap: rules
  }), '0.004');
});

test('handles quantities just below, at, and just above the maximum', () => {
  const rules = {
    amountStep: '0.002',
    contractSize: '1',
    minBaseAmount: '0.002',
    maxBaseAmount: '0.006'
  };

  assert.equal(normalizeCommonBaseQuantity({
    requestedBaseQuantity: '0.005999',
    spot: rules,
    swap: rules
  }), '0.004');
  assert.equal(normalizeCommonBaseQuantity({
    requestedBaseQuantity: '0.006',
    spot: rules,
    swap: rules
  }), '0.006');
  assert.equal(normalizeCommonBaseQuantity({
    requestedBaseQuantity: '0.006001',
    spot: rules,
    swap: rules
  }), '0.006');
});

test('uses the lower market maximum and aligns it down to the common step', () => {
  assert.equal(normalizeCommonBaseQuantity({
    requestedBaseQuantity: '0.02',
    spot: {
      amountStep: '0.003',
      contractSize: '1',
      minBaseAmount: '0.003',
      maxBaseAmount: '0.011'
    },
    swap: {
      amountStep: '3',
      contractSize: '0.001',
      minBaseAmount: '0.003',
      maxBaseAmount: '0.008'
    }
  }), '0.006');
});

test('preserves a requested quantity with more than forty significant digits', () => {
  const requested = '12345678901234567890123456789012345678901.9';

  // Integer cross-check: requested * 10 is an integer, so a 0.1 step needs no rounding.
  assert.equal(
    BigInt(requested.replace('.', '')),
    123456789012345678901234567890123456789019n
  );
  assert.equal(normalizeCommonBaseQuantity({
    requestedBaseQuantity: requested,
    spot: { amountStep: '0.1', contractSize: '1', minBaseAmount: '0.1' },
    swap: { amountStep: '0.1', contractSize: '1', minBaseAmount: '0.1' }
  }), requested);
});

test('keeps exact common-step arithmetic with a non-one contract multiplier', () => {
  const requested = '9007199254740993.9';

  // The swap base step is 1 * 0.3. requested / 0.3 = 30023997515803313.
  const scaled = BigInt(requested.replace('.', ''));
  assert.equal(scaled % 3n, 0n);
  assert.equal(scaled / 3n, 30023997515803313n);
  assert.equal(normalizeCommonBaseQuantity({
    requestedBaseQuantity: requested,
    spot: { amountStep: '0.1', contractSize: '1', minBaseAmount: '0.1' },
    swap: { amountStep: '1', contractSize: '0.3', minBaseAmount: '0.3' }
  }), requested);
});

test('clips a high-precision quantity at the lower exact market maximum', () => {
  assert.equal(normalizeCommonBaseQuantity({
    requestedBaseQuantity: '12345678901234567890123456789012345678901.9',
    spot: {
      amountStep: '0.1',
      contractSize: '1',
      minBaseAmount: '0.1',
      maxBaseAmount: '12345678901234567890123456789012345678901.8'
    },
    swap: {
      amountStep: '1',
      contractSize: '0.1',
      minBaseAmount: '0.1',
      maxBaseAmount: '12345678901234567890123456789012345678902.0'
    }
  }), '12345678901234567890123456789012345678901.8');
});

test('distinguishes alignment precision exhaustion from normalized zero', () => {
  assert.throws(() => normalizeCommonBaseQuantity({
    requestedBaseQuantity: '1e1000001',
    spot: { amountStep: '1', contractSize: '1', minBaseAmount: '0' },
    swap: { amountStep: '1', contractSize: '1', minBaseAmount: '0' }
  }), (error: unknown) => {
    assert(error instanceof Error);
    const failure = error as Error & { reason?: string; actual?: string };
    assert.equal(failure.reason, 'RESOURCE_LIMIT');
    assert.equal(failure.actual, '1000005');
    return true;
  });
});
