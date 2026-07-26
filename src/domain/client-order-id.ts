import { createHash } from 'node:crypto';
import type { OrderRole } from './types.js';

export function makeClientOrderId(
  strategyId: string,
  role: OrderRole
): string {
  return createHash('sha256')
    .update(strategyId)
    .update('\0')
    .update(role)
    .digest('hex')
    .slice(0, 32);
}
