import { Decimal } from 'decimal.js';

Decimal.set({ precision: 40, rounding: Decimal.ROUND_DOWN });

export function decimal(value: Decimal.Value): Decimal {
  return new Decimal(value);
}
