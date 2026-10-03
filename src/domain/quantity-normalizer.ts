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
  const requiredPrecision = amountStep.sd() + contractSize.sd() + 2;
  if (
    !Number.isSafeInteger(requiredPrecision)
    || requiredPrecision > 1_000_000
  ) {
    throw new Error(`invalid ${field}: exact result exceeds supported precision`);
  }
  const ExactDecimal = Decimal.clone({
    precision: Math.max(Decimal.precision, requiredPrecision),
    rounding: Decimal.ROUND_DOWN
  });
  return positiveDerivedDecimal(
    new ExactDecimal(amountStep.toString()).mul(contractSize.toString()),
    field
  );
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
  if (!Number.isSafeInteger(scale) || scale > 1_000_000) {
    throw new Error('invalid commonStep: exact result exceeds supported precision');
  }
  const factor = 10n ** BigInt(scale);
  const ExactDecimal = Decimal.clone({
    precision: Math.max(Decimal.precision, left.sd(), right.sd()),
    rounding: Decimal.ROUND_DOWN
  });
  const a = BigInt(new ExactDecimal(left.toString()).mul(factor.toString()).toFixed(0));
  const b = BigInt(new ExactDecimal(right.toString()).mul(factor.toString()).toFixed(0));
  const multiple = (a / gcd(a, b)) * b;
  const ResultDecimal = Decimal.clone({
    precision: Math.max(Decimal.precision, multiple.toString().length),
    rounding: Decimal.ROUND_DOWN
  });
  return new ResultDecimal(multiple.toString()).div(factor.toString());
}

function alignedDown(value: Decimal, step: Decimal): Decimal {
  const integerDigits = Math.max(1, value.e - step.e + 1);
  const requiredPrecision = Math.max(
    value.sd() + step.sd() + 2,
    integerDigits + step.sd() + 2
  );
  if (
    !Number.isSafeInteger(requiredPrecision)
    || requiredPrecision > 1_000_000
  ) {
    throw new Error('invalid effective quantity: exact result exceeds supported precision');
  }
  const ExactDecimal = Decimal.clone({
    precision: Math.max(Decimal.precision, requiredPrecision),
    rounding: Decimal.ROUND_DOWN
  });
  const exactStep = new ExactDecimal(step.toString());
  return new ExactDecimal(value.toString()).div(exactStep).floor().mul(exactStep);
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
  let effective = alignedDown(requested, step);

  for (const maximum of [spot.maxBaseAmount, swap.maxBaseAmount]) {
    if (maximum !== undefined) {
      const alignedMaximum = alignedDown(maximum, step);
      if (alignedMaximum.lt(effective)) {
        effective = alignedMaximum;
      }
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
