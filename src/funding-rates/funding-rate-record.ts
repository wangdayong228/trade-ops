import { createHash } from 'node:crypto';
import { Decimal } from 'decimal.js';

export type FundingExchangeId = 'bitget' | 'okx';

export interface FundingMarketIdentity {
  readonly exchangeId: FundingExchangeId;
  readonly exchangeMarketId: string;
  readonly symbol: string;
}

export interface FundingMarketObservation extends FundingMarketIdentity {
  readonly active: boolean;
}

export interface SettledFundingRate extends FundingMarketIdentity {
  readonly fundingTimestampMs: number;
  readonly fundingRate: string;
  readonly rawJson: string;
  readonly contentHash: string;
}

const DECIMAL_STRING_PATTERN =
  /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const CANONICAL_TIMESTAMP_PATTERN = /^(?:0|[1-9]\d*)$/;
const MIN_DECIMAL_EXPONENT = -9_000_000_000_000_000;
const MAX_DECIMAL_EXPONENT = 9_000_000_000_000_000;
const FundingRateDecimal = Decimal.clone({
  minE: MIN_DECIMAL_EXPONENT,
  maxE: MAX_DECIMAL_EXPONENT
});

function invalid(field: string, requirement: string): never {
  throw new Error(`Invalid ${field}: ${requirement}`);
}

function fundingExchangeId(value: unknown): FundingExchangeId {
  if (value !== 'bitget' && value !== 'okx') {
    return invalid('exchangeId', 'expected bitget or okx');
  }
  return value;
}

function identityString(value: unknown, field: string): string {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.trim() !== value
  ) {
    return invalid(field, 'expected a non-empty string without outer whitespace');
  }
  return value;
}

function fundingRate(value: unknown): string {
  if (typeof value !== 'string') {
    return invalid('funding rate', 'expected a decimal string');
  }
  const normalized = value.trim();
  if (normalized.length === 0 || !DECIMAL_STRING_PATTERN.test(normalized)) {
    return invalid('funding rate', 'expected a finite decimal string');
  }

  let parsed: Decimal;
  try {
    parsed = new FundingRateDecimal(normalized);
  } catch {
    return invalid('funding rate', 'expected a finite decimal string');
  }
  const coefficient = normalized.split(/[eE]/, 1)[0] ?? '';
  const isLexicalZero = !/[1-9]/.test(coefficient);
  if (!parsed.isFinite() || (parsed.isZero() && !isLexicalZero)) {
    return invalid('funding rate', 'expected a finite decimal string');
  }
  return normalized;
}

function fundingTimestamp(value: unknown): number {
  let timestampMs: number;
  if (typeof value === 'number') {
    timestampMs = value;
  } else if (
    typeof value === 'string'
    && CANONICAL_TIMESTAMP_PATTERN.test(value)
  ) {
    timestampMs = Number(value);
  } else {
    return invalid(
      'funding timestamp',
      'expected a canonical non-negative Unix millisecond timestamp'
    );
  }

  if (
    !Number.isSafeInteger(timestampMs)
    || timestampMs < 0
    || Number.isNaN(new Date(timestampMs).getTime())
  ) {
    return invalid(
      'funding timestamp',
      'expected a valid non-negative safe-integer Unix millisecond timestamp'
    );
  }
  return timestampMs;
}

interface DataDescriptor {
  readonly key: string;
  readonly descriptor: PropertyDescriptor;
}

function dataDescriptors(value: object, path: string): DataDescriptor[] {
  const entries: DataDescriptor[] = [];
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key === 'symbol') {
      return invalid(path, 'symbol keys are not supported');
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined) {
      return invalid(path, `property ${JSON.stringify(key)} has no descriptor`);
    }
    if ('get' in descriptor || 'set' in descriptor) {
      return invalid(path, `property ${JSON.stringify(key)} must be a data property`);
    }
    entries.push({ key, descriptor });
  }
  return entries;
}

function quotedJson(value: string, path: string): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    return invalid(path, 'string cannot be represented as JSON');
  }
  return serialized;
}

function numberJson(value: number, path: string): string {
  if (!Number.isFinite(value)) {
    return invalid(path, 'number must be finite');
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    return invalid(path, 'number cannot be represented as JSON');
  }
  return serialized;
}

function arrayJson(
  value: readonly unknown[],
  ancestors: Set<object>,
  path: string
): string {
  const descriptors = dataDescriptors(value, path);
  const byKey = new Map(descriptors.map((entry) => [entry.key, entry.descriptor]));
  for (const { key } of descriptors) {
    if (key === 'length') {
      continue;
    }
    const index = Number(key);
    if (
      !Number.isSafeInteger(index)
      || index < 0
      || index >= value.length
      || String(index) !== key
    ) {
      return invalid(path, `array property ${JSON.stringify(key)} is not supported`);
    }
  }

  const items: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = byKey.get(String(index));
    if (descriptor === undefined) {
      return invalid(path, `array index ${index} is missing`);
    }
    items.push(canonicalJson(descriptor.value, ancestors, `${path}[${index}]`));
  }
  return `[${items.join(',')}]`;
}

function objectJson(
  value: object,
  ancestors: Set<object>,
  path: string
): string {
  const entries = dataDescriptors(value, path)
    .filter(({ descriptor }) => descriptor.enumerable === true)
    .sort((left, right) => left.key < right.key ? -1 : left.key > right.key ? 1 : 0);
  const properties = entries.map(({ key, descriptor }) => {
    const propertyPath = `${path}.${key}`;
    return `${quotedJson(key, propertyPath)}:${canonicalJson(
      descriptor.value,
      ancestors,
      propertyPath
    )}`;
  });
  return `{${properties.join(',')}}`;
}

function canonicalJson(
  value: unknown,
  ancestors: Set<object>,
  path: string
): string {
  if (value === null) {
    return 'null';
  }
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }
  if (typeof value === 'string') {
    return quotedJson(value, path);
  }
  if (typeof value === 'number') {
    return numberJson(value, path);
  }
  if (typeof value !== 'object') {
    return invalid(path, 'value is not supported in JSON');
  }
  if (ancestors.has(value)) {
    return invalid(path, 'cyclic references are not supported');
  }

  const isArray = Array.isArray(value);
  if (!isArray && Object.getPrototypeOf(value) !== Object.prototype) {
    return invalid(path, 'object must have the plain Object prototype');
  }

  ancestors.add(value);
  try {
    return isArray
      ? arrayJson(value, ancestors, path)
      : objectJson(value, ancestors, path);
  } finally {
    ancestors.delete(value);
  }
}

function rawRecordJson(value: unknown): string {
  if (
    typeof value !== 'object'
    || value === null
    || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
  ) {
    return invalid('raw record', 'root must be a plain object');
  }
  return canonicalJson(value, new Set<object>(), 'raw record');
}

export function settledFundingRate(
  identity: FundingMarketIdentity,
  rawRate: unknown,
  rawTimestampMs: unknown,
  rawRecord: unknown
): SettledFundingRate {
  const exchangeId = fundingExchangeId(identity.exchangeId);
  const exchangeMarketId = identityString(
    identity.exchangeMarketId,
    'exchangeMarketId'
  );
  const symbol = identityString(identity.symbol, 'symbol');
  const normalizedRate = fundingRate(rawRate);
  const fundingTimestampMs = fundingTimestamp(rawTimestampMs);
  const rawJson = rawRecordJson(rawRecord);
  const semanticJson =
    `{"exchangeId":${quotedJson(exchangeId, 'exchangeId')}`
    + `,"exchangeMarketId":${quotedJson(exchangeMarketId, 'exchangeMarketId')}`
    + `,"fundingRate":${quotedJson(normalizedRate, 'funding rate')}`
    + `,"fundingTimestampMs":${fundingTimestampMs}`
    + `,"raw":${rawJson}`
    + `,"symbol":${quotedJson(symbol, 'symbol')}}`;

  return {
    exchangeId,
    exchangeMarketId,
    symbol,
    fundingTimestampMs,
    fundingRate: normalizedRate,
    rawJson,
    contentHash: createHash('sha256').update(semanticJson).digest('hex')
  };
}
