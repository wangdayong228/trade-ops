/// <reference types="node" />

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  baseStepFor,
  normalizeCommonBaseQuantity
} from '../../src/domain/quantity-normalizer.js';

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
