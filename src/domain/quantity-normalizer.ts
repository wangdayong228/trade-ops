import { Decimal } from 'decimal.js';
import { decimal } from './decimal.js';

export interface TradableAmountRules {
  amountStep: string;
  contractSize: string;
  minBaseAmount: string;
  maxBaseAmount?: string;
}

export interface CommonQuantityInput {
  requestedBaseQuantity: string;
  spot: TradableAmountRules;
  swap: TradableAmountRules;
}

interface ValidatedAmountRules {
  amountStep: Decimal;
  contractSize: Decimal;
  minBaseAmount: Decimal;
  maxBaseAmount: Decimal | undefined;
}

function parsedDecimal(value: string, field: string): Decimal {
  try {
    return decimal(value);
  } catch {
    throw new Error(`invalid ${field}: must be a decimal`);
  }
}

function positiveDecimal(value: string, field: string): Decimal {
  const parsed = parsedDecimal(value, field);
  if (!parsed.isFinite() || parsed.lte('0')) {
    throw new Error(`invalid ${field}: must be finite and greater than zero`);
  }
  return parsed;
}

function nonNegativeDecimal(value: string, field: string): Decimal {
  const parsed = parsedDecimal(value, field);
  if (!parsed.isFinite() || parsed.lt('0')) {
    throw new Error(`invalid ${field}: must be finite and non-negative`);
  }
  return parsed;
}

function positiveDerivedDecimal(value: Decimal, field: string): Decimal {
  if (!value.isFinite() || value.lte('0')) {
    throw new Error(`invalid ${field}: derived value must be finite and greater than zero`);
  }
  return value;
}

function derivedBaseStep(
  amountStep: Decimal,
  contractSize: Decimal,
  field: string
): Decimal {
  return positiveDerivedDecimal(amountStep.mul(contractSize), field);
}

function validatedRules(
  market: 'spot' | 'swap',
  rules: TradableAmountRules
): ValidatedAmountRules {
  return {
    amountStep: positiveDecimal(rules.amountStep, `${market}.amountStep`),
    contractSize: positiveDecimal(rules.contractSize, `${market}.contractSize`),
    minBaseAmount: nonNegativeDecimal(rules.minBaseAmount, `${market}.minBaseAmount`),
    maxBaseAmount: rules.maxBaseAmount === undefined
      ? undefined
      : positiveDecimal(rules.maxBaseAmount, `${market}.maxBaseAmount`)
  };
}

export function baseStepFor(rules: TradableAmountRules): Decimal {
  return derivedBaseStep(
    positiveDecimal(rules.amountStep, 'amountStep'),
    positiveDecimal(rules.contractSize, 'contractSize'),
    'baseStep'
  );
}

function gcd(left: bigint, right: bigint): bigint {
  let a = left;
  let b = right;
  while (b !== 0n) {
    const remainder = a % b;
    a = b;
    b = remainder;
  }
  return a;
}

function commonStep(left: Decimal, right: Decimal): Decimal {
  const scale = Math.max(left.decimalPlaces(), right.decimalPlaces());
  const factor = 10n ** BigInt(scale);
  const a = BigInt(left.mul(factor.toString()).toFixed(0));
  const b = BigInt(right.mul(factor.toString()).toFixed(0));
  const multiple = (a / gcd(a, b)) * b;
  return decimal(multiple.toString()).div(factor.toString());
}

export function normalizeCommonBaseQuantity(input: CommonQuantityInput): string {
  const requested = positiveDecimal(input.requestedBaseQuantity, 'requestedBaseQuantity');
  const spot = validatedRules('spot', input.spot);
  const swap = validatedRules('swap', input.swap);
  const spotBaseStep = derivedBaseStep(
    spot.amountStep,
    spot.contractSize,
    'spot.baseStep'
  );
  const swapBaseStep = derivedBaseStep(
    swap.amountStep,
    swap.contractSize,
    'swap.baseStep'
  );
  const step = positiveDerivedDecimal(
    commonStep(spotBaseStep, swapBaseStep),
    'commonStep'
  );
  let effective = requested.div(step).floor().mul(step);

  for (const maximum of [spot.maxBaseAmount, swap.maxBaseAmount]) {
    if (maximum !== undefined) {
      effective = Decimal.min(effective, maximum.div(step).floor().mul(step));
    }
  }

  if (!effective.isFinite()) {
    throw new Error('invalid effective quantity: must be finite');
  }
  if (
    effective.lte('0')
    || effective.lt(spot.minBaseAmount)
    || effective.lt(swap.minBaseAmount)
  ) {
    throw new Error('normalized quantity is below a market minimum');
  }
  return effective.toFixed();
}
