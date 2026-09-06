import type {
  FundingExchangeId,
  FundingMarketIdentity,
  FundingMarketObservation,
  SettledFundingRate
} from './funding-rate-record.js';
import { settledFundingRate } from './funding-rate-record.js';

export type FundingSourceExchangeName = 'Bitget' | 'OKX';

export interface FundingCurrencyCodeClient {
  safeCurrencyCode(currencyId?: string): unknown;
}

export interface FundingDiscoveryCandidate {
  readonly exchangeMarketId: string;
  readonly observation: FundingMarketObservation | null;
}

export interface FundingResponseShape {
  readonly successCode: string;
  readonly requireRequestTime: boolean;
  readonly maximumRecords: number | null;
  readonly context: 'discovery' | 'history';
}

function describeActual(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  if (typeof value === 'string') {
    const visible = value
      .slice(0, 64)
      .replace(/[\u0000-\u001f\u007f]/g, '?');
    const suffix = value.length > 64 ? '...' : '';
    return `string ${JSON.stringify(visible + suffix)} (length ${value.length})`;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return `${typeof value} ${String(value)}`;
  }
  if (Array.isArray(value)) {
    return `array (length ${value.length})`;
  }
  return typeof value;
}

export function invalidSourceValue(
  exchange: FundingSourceExchangeName,
  field: string,
  expected: string,
  actual: unknown
): never {
  throw new Error(
    `${exchange} ${field} invalid: expected ${expected}; actual ${describeActual(actual)}`
  );
}

function plainSourceRecord(
  exchange: FundingSourceExchangeName,
  value: unknown,
  field: string
): object {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return invalidSourceValue(exchange, field, 'a plain object', value);
  }

  let prototype: object | null;
  let keys: readonly PropertyKey[];
  try {
    prototype = Object.getPrototypeOf(value);
    keys = Reflect.ownKeys(value);
  } catch {
    return invalidSourceValue(exchange, field, 'an inspectable plain object', value);
  }
  if (prototype !== Object.prototype) {
    return invalidSourceValue(
      exchange,
      field,
      'an object with the plain Object prototype',
      value
    );
  }

  for (const key of keys) {
    if (typeof key === 'symbol') {
      return invalidSourceValue(
        exchange,
        field,
        'a plain object without symbol properties',
        value
      );
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !('value' in descriptor)) {
      return invalidSourceValue(
        exchange,
        `${field}.${key}`,
        'an own data property',
        descriptor
      );
    }
  }
  return value;
}

export function ownSourceValue(
  exchange: FundingSourceExchangeName,
  record: object,
  key: string,
  field: string
): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (descriptor === undefined || !('value' in descriptor)) {
    return invalidSourceValue(exchange, field, 'an own data property', undefined);
  }
  return descriptor.value;
}

export function strictSourceString(
  exchange: FundingSourceExchangeName,
  value: unknown,
  field: string
): string {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.trim() !== value
  ) {
    return invalidSourceValue(
      exchange,
      field,
      'a non-empty string without outer whitespace',
      value
    );
  }
  return value;
}

export function sourceArrayItems(
  exchange: FundingSourceExchangeName,
  value: unknown,
  field: string
): readonly unknown[] {
  if (!Array.isArray(value)) {
    return invalidSourceValue(exchange, field, 'an array', value);
  }
  if (Object.getPrototypeOf(value) !== Array.prototype) {
    return invalidSourceValue(exchange, field, 'a plain array', value);
  }

  const items: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !('value' in descriptor)) {
      return invalidSourceValue(
        exchange,
        `${field}[${index}]`,
        'an own data property',
        undefined
      );
    }
    items.push(descriptor.value);
  }
  return items;
}

export function fundingResponseRecords(
  exchange: FundingSourceExchangeName,
  response: unknown,
  shape: FundingResponseShape
): readonly object[] {
  const root = plainSourceRecord(exchange, response, `${shape.context}.root`);
  const code = ownSourceValue(
    exchange,
    root,
    'code',
    `${shape.context}.code`
  );
  if (code !== shape.successCode) {
    return invalidSourceValue(
      exchange,
      `${shape.context}.code`,
      JSON.stringify(shape.successCode),
      code
    );
  }

  const message = ownSourceValue(
    exchange,
    root,
    'msg',
    `${shape.context}.msg`
  );
  if (typeof message !== 'string') {
    return invalidSourceValue(
      exchange,
      `${shape.context}.msg`,
      'a string',
      message
    );
  }

  if (shape.requireRequestTime) {
    const requestTime = ownSourceValue(
      exchange,
      root,
      'requestTime',
      `${shape.context}.requestTime`
    );
    if (
      typeof requestTime !== 'number'
      || !Number.isSafeInteger(requestTime)
      || requestTime < 0
    ) {
      return invalidSourceValue(
        exchange,
        `${shape.context}.requestTime`,
        'a non-negative safe-integer number',
        requestTime
      );
    }
  }

  const data = sourceArrayItems(
    exchange,
    ownSourceValue(exchange, root, 'data', `${shape.context}.data`),
    `${shape.context}.data`
  );
  if (
    shape.maximumRecords !== null
    && data.length > shape.maximumRecords
  ) {
    return invalidSourceValue(
      exchange,
      `${shape.context} page size`,
      `at most ${shape.maximumRecords} records`,
      data
    );
  }

  return data.map((record, index) => plainSourceRecord(
    exchange,
    record,
    `${shape.context}.data[${index}]`
  ));
}

export function normalizedCurrencyCode(
  exchange: FundingSourceExchangeName,
  client: FundingCurrencyCodeClient,
  currencyId: string,
  field: string
): string {
  let value: unknown;
  try {
    value = client.safeCurrencyCode(currencyId);
  } catch {
    return invalidSourceValue(
      exchange,
      field,
      'safeCurrencyCode to return a valid currency code',
      'safeCurrencyCode threw'
    );
  }
  return strictSourceString(exchange, value, field);
}

export function completeFundingMarketDiscovery(
  exchange: FundingSourceExchangeName,
  candidates: readonly FundingDiscoveryCandidate[]
): readonly FundingMarketObservation[] {
  const seenMarketIds = new Set<string>();
  const marketIdBySymbol = new Map<string, string>();
  const observations: FundingMarketObservation[] = [];

  for (const candidate of candidates) {
    if (seenMarketIds.has(candidate.exchangeMarketId)) {
      return invalidSourceValue(
        exchange,
        'discovery duplicate exchangeMarketId',
        'each raw market ID to occur exactly once',
        candidate.exchangeMarketId
      );
    }
    seenMarketIds.add(candidate.exchangeMarketId);

    if (candidate.observation === null) {
      continue;
    }
    const existingMarketId = marketIdBySymbol.get(candidate.observation.symbol);
    if (
      existingMarketId !== undefined
      && existingMarketId !== candidate.exchangeMarketId
    ) {
      return invalidSourceValue(
        exchange,
        'discovery unified symbol identity conflict',
        'one raw market ID per unified symbol',
        candidate.observation.symbol
      );
    }
    marketIdBySymbol.set(
      candidate.observation.symbol,
      candidate.exchangeMarketId
    );
    observations.push(candidate.observation);
  }

  return observations;
}

export function requireFundingMarketIdentity(
  exchange: FundingSourceExchangeName,
  expectedExchangeId: FundingExchangeId,
  market: FundingMarketIdentity
): void {
  if (market.exchangeId !== expectedExchangeId) {
    invalidSourceValue(
      exchange,
      'market.exchangeId',
      JSON.stringify(expectedExchangeId),
      market.exchangeId
    );
  }
  strictSourceString(
    exchange,
    market.exchangeMarketId,
    'market.exchangeMarketId'
  );
  strictSourceString(exchange, market.symbol, 'market.symbol');
}

export function sourceSettledFundingRate(
  exchange: FundingSourceExchangeName,
  identity: FundingMarketIdentity,
  rawRate: unknown,
  rawTimestampMs: unknown,
  rawRecord: object
): SettledFundingRate {
  try {
    return settledFundingRate(
      identity,
      rawRate,
      rawTimestampMs,
      rawRecord
    );
  } catch (error) {
    const detail = error instanceof Error && error.message.startsWith('Invalid ')
      ? error.message
      : 'record normalization failed';
    throw new Error(`${exchange} history record invalid: ${detail}`);
  }
}

function sameSettledRecord(
  left: SettledFundingRate,
  right: SettledFundingRate
): boolean {
  return left.exchangeId === right.exchangeId
    && left.exchangeMarketId === right.exchangeMarketId
    && left.symbol === right.symbol
    && left.fundingTimestampMs === right.fundingTimestampMs
    && left.fundingRate === right.fundingRate
    && left.rawJson === right.rawJson
    && left.contentHash === right.contentHash;
}

export function uniqueSettledPageRecords(
  exchange: FundingSourceExchangeName,
  records: readonly SettledFundingRate[]
): readonly SettledFundingRate[] {
  const byTimestamp = new Map<number, SettledFundingRate>();
  for (const record of records) {
    const existing = byTimestamp.get(record.fundingTimestampMs);
    if (existing === undefined) {
      byTimestamp.set(record.fundingTimestampMs, record);
      continue;
    }
    if (!sameSettledRecord(existing, record)) {
      return invalidSourceValue(
        exchange,
        'history duplicate timestamp conflict',
        'identical normalized records for one natural key',
        record.fundingTimestampMs
      );
    }
  }
  return [...byTimestamp.values()].sort(
    (left, right) => right.fundingTimestampMs - left.fundingTimestampMs
  );
}
