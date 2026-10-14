import { isProxy } from 'node:util/types';
import type {
  AccountSettings,
  OrderRequest
} from '../domain/types.js';
import type {
  CcxtExchangeLike
} from './ccxt-exchange-gateway.js';
import {
  diagnosticValue,
  redactEvidenceText,
  type ErrorEvidence
} from '../errors/error-evidence.js';

export function accountFieldEvidence(
  response: unknown,
  field: string
): string {
  let value = response;
  const path: string[] = [];
  for (const part of field.split('.')) {
    if (typeof value !== 'object' || value === null) {
      return `${field}=unavailable (${path.join('.')}=${diagnosticValue(value)})`;
    }
    if (isProxy(value)) return `${field}=unreadable Proxy object`;
    path.push(part);
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, part);
    } catch {
      return `${path.join('.')}=unreadable property`;
    }
    if (descriptor !== undefined && !('value' in descriptor)) {
      return `${path.join('.')}=accessor unreadable`;
    }
    value = descriptor?.value;
  }
  return `${field}=${diagnosticValue(value)}`;
}

export function accountSettingsEvidence(
  exchangeId: string,
  exchangeSymbol: string,
  check: string,
  expected: string,
  actual: string
): ErrorEvidence {
  return Object.freeze({
    type: 'AccountSettingsEvidence',
    message: redactEvidenceText(
      `${exchangeId.toUpperCase()} ${exchangeSymbol} ${check}检查失败：期望 ${expected}；实际 ${actual}`
    )
  });
}

export interface ExchangeProfile {
  readonly exchangeId: 'bitget' | 'okx';
  balanceParams(kind: 'spot' | 'swap'): Record<string, unknown>;
  buildCreateOrderParams(request: OrderRequest): Record<string, unknown>;
  prepareSubmissionPrice(
    request: OrderRequest,
    exchange: CcxtExchangeLike,
    exchangeSymbol: string,
    formattedPrice: string | undefined
  ): Promise<string | undefined>;
  clientOrderLookupParams(
    clientOrderId: string
  ): Record<string, unknown>;
  fetchAccountSettings(
    exchange: CcxtExchangeLike,
    exchangeSymbol: string
  ): Promise<AccountSettings>;
}

export function buildCreateOrderParams(
  request: OrderRequest
): Record<string, unknown> {
  const params: Record<string, unknown> = {
    clientOrderId: request.clientOrderId
  };
  if (request.timeInForce !== undefined) {
    params.timeInForce = request.timeInForce;
  }
  if (request.kind === 'swap') {
    params.reduceOnly = false;
    if (request.marginMode !== undefined) {
      params.marginMode = request.marginMode;
    }
  }
  if (request.positionSide !== undefined) {
    params.positionSide = request.positionSide;
  }
  return params;
}
