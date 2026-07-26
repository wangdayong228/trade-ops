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

export function baseStepFor(rules: TradableAmountRules): Decimal {
  return decimal(rules.amountStep).mul(rules.contractSize);
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
  const requested = decimal(input.requestedBaseQuantity);
  const step = commonStep(baseStepFor(input.spot), baseStepFor(input.swap));
  let effective = requested.div(step).floor().mul(step);

  for (const maximum of [input.spot.maxBaseAmount, input.swap.maxBaseAmount]) {
    if (maximum !== undefined) {
      effective = Decimal.min(effective, decimal(maximum).div(step).floor().mul(step));
    }
  }

  if (
    effective.lte(0)
    || effective.lt(input.spot.minBaseAmount)
    || effective.lt(input.swap.minBaseAmount)
  ) {
    throw new Error('normalized quantity is below a market minimum');
  }
  return effective.toFixed();
}
