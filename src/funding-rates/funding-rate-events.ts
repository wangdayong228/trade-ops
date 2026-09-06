import type { Logger } from 'pino';
import {
  nonEmptySecrets,
  nonThrowingLogCall,
  redactText,
  safeError,
  utf8Prefix,
  type SafeError
} from '../logging/logger.js';
import type { FundingExchangeId } from './funding-rate-record.js';
import type {
  FundingPageCursor,
  FundingRequestMetadata
} from './funding-rate-source.js';

export const MAX_FUNDING_RATE_EVENT_ERROR_FIELD_BYTES = 512;

export type FundingCoverageKind =
  | 'INITIAL'
  | 'PERIODIC'
  | 'INACTIVE_FINAL'
  | 'REACTIVATION';

interface FundingSyncStartedEvent {
  readonly event: 'funding_sync_started';
  readonly phase: string;
}

interface FundingSyncStoppedEvent {
  readonly event: 'funding_sync_stopped';
  readonly phase: string;
}

interface FundingMarketDiscoveryCompletedEvent {
  readonly event: 'funding_market_discovery_completed';
  readonly exchangeId: FundingExchangeId;
  readonly phase: string;
  readonly observedActiveCount: number;
  readonly observedInactiveCount: number;
  readonly createdActiveCount: number;
  readonly becameInactiveCount: number;
  readonly reactivatedCount: number;
}

interface FundingMarketDiscoveryIncompleteEvent {
  readonly event: 'funding_market_discovery_incomplete';
  readonly exchangeId: FundingExchangeId;
  readonly phase: string;
  readonly request: FundingRequestMetadata;
  readonly error: SafeError;
}

interface FundingCoverageEventFields {
  readonly exchangeId: FundingExchangeId;
  readonly exchangeMarketId: string;
  readonly symbol: string;
  readonly phase: string;
  readonly taskKind: FundingCoverageKind;
  readonly generation: number;
}

interface FundingIncrementalEventFields {
  readonly exchangeId: FundingExchangeId;
  readonly exchangeMarketId: string;
  readonly symbol: string;
  readonly phase: string;
  readonly generation: number;
}

interface FundingCoverageStartedEvent extends FundingCoverageEventFields {
  readonly event: 'funding_coverage_started';
  readonly coverageCutoffMs: number;
  readonly cursor: FundingPageCursor;
}

interface FundingPageCommittedEvent extends FundingCoverageEventFields {
  readonly event: 'funding_page_committed';
  readonly cursor: FundingPageCursor;
  readonly inserted: number;
  readonly unchanged: number;
  readonly revised: number;
}

interface FundingCoverageCompletedEvent extends FundingCoverageEventFields {
  readonly event: 'funding_coverage_completed';
  readonly coverageCutoffMs: number;
  readonly lastCaughtUpCutoffMs: number;
}

interface FundingIncrementalCompletedEvent extends FundingIncrementalEventFields {
  readonly event: 'funding_incremental_completed';
  readonly inserted: number;
  readonly unchanged: number;
  readonly revised: number;
}

interface FundingIncrementalBlockedEvent extends FundingIncrementalEventFields {
  readonly event: 'funding_incremental_blocked';
}

interface FundingRequestRetryFields {
  readonly retryAttempt: number;
  readonly retryDelayMs: number;
  readonly request: FundingRequestMetadata;
  readonly error: SafeError;
}

interface FundingCoverageRequestRetryEvent
  extends FundingCoverageEventFields, FundingRequestRetryFields {
  readonly event: 'funding_request_retry';
  readonly taskCategory: 'coverage';
  readonly coverageCutoffMs: number;
  readonly cursor: FundingPageCursor;
}

interface FundingIncrementalRequestRetryEvent
  extends FundingIncrementalEventFields, FundingRequestRetryFields {
  readonly event: 'funding_request_retry';
  readonly taskCategory: 'incremental';
  readonly frozenBoundaryMs: number | null;
  readonly cursor: FundingPageCursor;
}

interface FundingDiscoveryRequestRetryEvent extends FundingRequestRetryFields {
  readonly event: 'funding_request_retry';
  readonly taskCategory: 'discovery';
  readonly exchangeId: FundingExchangeId;
  readonly phase: string;
}

type FundingRequestRetryEvent =
  | FundingCoverageRequestRetryEvent
  | FundingIncrementalRequestRetryEvent
  | FundingDiscoveryRequestRetryEvent;

interface FundingCoverageTaskIncompleteEvent
  extends FundingCoverageEventFields {
  readonly event: 'funding_task_incomplete';
  readonly taskCategory: 'coverage';
  readonly coverageCutoffMs: number;
  readonly cursor: FundingPageCursor;
  readonly request: FundingRequestMetadata;
  readonly error: SafeError;
}

interface FundingIncrementalTaskIncompleteEvent
  extends FundingIncrementalEventFields {
  readonly event: 'funding_task_incomplete';
  readonly taskCategory: 'incremental';
  readonly frozenBoundaryMs: number | null;
  readonly cursor: FundingPageCursor;
  readonly request: FundingRequestMetadata;
  readonly error: SafeError;
}

type FundingTaskIncompleteEvent =
  | FundingCoverageTaskIncompleteEvent
  | FundingIncrementalTaskIncompleteEvent;

interface FundingRateRevisedEvent {
  readonly event: 'funding_rate_revised';
  readonly exchangeId: FundingExchangeId;
  readonly exchangeMarketId: string;
  readonly symbol: string;
  readonly phase: string;
  readonly fundingTimestampMs: number;
  readonly previousContentHash: string;
  readonly currentContentHash: string;
}

interface FundingSyncFatalEvent {
  readonly event: 'funding_sync_fatal';
  readonly phase: string;
  readonly error: SafeError;
}

export type FundingRateEvent =
  | FundingSyncStartedEvent
  | FundingSyncStoppedEvent
  | FundingMarketDiscoveryCompletedEvent
  | FundingMarketDiscoveryIncompleteEvent
  | FundingCoverageStartedEvent
  | FundingPageCommittedEvent
  | FundingCoverageCompletedEvent
  | FundingIncrementalCompletedEvent
  | FundingIncrementalBlockedEvent
  | FundingRequestRetryEvent
  | FundingTaskIncompleteEvent
  | FundingRateRevisedEvent
  | FundingSyncFatalEvent;

type FundingRateEventInputFor<Event extends FundingRateEvent> =
  Event extends { readonly error: SafeError }
    ? Omit<Event, 'error'> & { readonly error: unknown }
    : Event;

export type FundingRateEventInput = FundingRateEvent extends infer Event
  ? Event extends FundingRateEvent
    ? FundingRateEventInputFor<Event>
    : never
  : never;

export interface FundingRateEventSink {
  record(event: Readonly<FundingRateEvent>): void;
}

export const NOOP_FUNDING_RATE_EVENT_SINK: FundingRateEventSink = Object.freeze({
  record(_event: Readonly<FundingRateEvent>): void {}
});

const NON_THROWING_FUNDING_RATE_EVENT_SINKS = new WeakMap<
  FundingRateEventSink,
  FundingRateEventSink
>();

const APPROVED_QUERY_KEYS = [
  'symbol',
  'productType',
  'pageNo',
  'pageSize',
  'instType',
  'instId',
  'after',
  'limit'
] as const;

function stringProperty(value: unknown, property: string): string | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  try {
    const candidate = Reflect.get(value, property);
    return typeof candidate === 'string' ? candidate : undefined;
  } catch {
    return undefined;
  }
}

function boundedErrorField(
  value: string,
  secrets: readonly string[]
): string {
  return utf8Prefix(
    redactText(value, secrets),
    MAX_FUNDING_RATE_EVENT_ERROR_FIELD_BYTES
  );
}

function allowlistedError(
  error: unknown,
  secrets: readonly string[]
): SafeError {
  const errorName = stringProperty(error, 'name');
  const errorType = stringProperty(error, 'type');
  const source = errorName === undefined && errorType !== undefined
    ? {
        name: errorType,
        message: stringProperty(error, 'message') ?? 'Unknown error',
        ...(stringProperty(error, 'code') === undefined
          ? {}
          : { code: stringProperty(error, 'code') }),
        ...(stringProperty(error, 'stack') === undefined
          ? {}
          : { stack: stringProperty(error, 'stack') })
      }
    : error;
  const output = safeError(source, secrets);
  return {
    type: boundedErrorField(output.type, secrets),
    message: boundedErrorField(output.message, secrets),
    ...(output.code === undefined
      ? {}
      : { code: boundedErrorField(output.code, secrets) }),
    ...(output.stack === undefined
      ? {}
      : { stack: boundedErrorField(output.stack, secrets) })
  };
}

type UnknownRecord = Readonly<Record<string, unknown>>;

function invalidEventField(field: string, expected: string): never {
  throw new Error(`invalid funding rate event ${field}: expected ${expected}`);
}

function plainRecord(value: unknown, field: string): UnknownRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return invalidEventField(field, 'a plain object');
  }
  let prototype: object | null;
  try {
    prototype = Object.getPrototypeOf(value);
  } catch {
    return invalidEventField(field, 'a plain object');
  }
  if (prototype !== Object.prototype && prototype !== null) {
    return invalidEventField(field, 'a plain object');
  }
  return value as UnknownRecord;
}

function ownValue(
  record: UnknownRecord,
  property: string,
  field: string = property
): unknown {
  let present: boolean;
  try {
    present = Object.prototype.hasOwnProperty.call(record, property);
  } catch {
    return invalidEventField(field, 'an own field');
  }
  if (!present) {
    return invalidEventField(field, 'an own field');
  }
  try {
    return Reflect.get(record, property);
  } catch {
    return invalidEventField(field, 'a readable own field');
  }
}

function optionalOwnValue(
  record: UnknownRecord,
  property: string,
  field: string
): unknown | undefined {
  let present: boolean;
  try {
    present = Object.prototype.hasOwnProperty.call(record, property);
  } catch {
    return invalidEventField(field, 'a readable optional field');
  }
  return present ? ownValue(record, property, field) : undefined;
}

function requiredString(value: unknown, field: string): string {
  return typeof value === 'string'
    ? value
    : invalidEventField(field, 'a string');
}

function nonNegativeSafeInteger(value: unknown, field: string): number {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value >= 0
    ? value
    : invalidEventField(field, 'a non-negative safe integer');
}

function nullableNonNegativeSafeInteger(
  value: unknown,
  field: string
): number | null {
  return value === null ? null : nonNegativeSafeInteger(value, field);
}

function fundingExchangeId(
  value: unknown,
  field: string = 'exchangeId'
): FundingExchangeId {
  if (value === 'bitget' || value === 'okx') {
    return value;
  }
  return invalidEventField(field, 'bitget or okx');
}

function coverageKind(value: unknown): FundingCoverageKind {
  switch (value) {
    case 'INITIAL':
    case 'PERIODIC':
    case 'INACTIVE_FINAL':
    case 'REACTIVATION':
      return value;
    default:
      return invalidEventField('taskKind', 'an approved coverage task kind');
  }
}

function retryTaskCategory(
  value: unknown
): FundingRequestRetryEvent['taskCategory'] {
  if (value === 'coverage' || value === 'incremental' || value === 'discovery') {
    return value;
  }
  return invalidEventField(
    'taskCategory',
    'coverage, incremental, or discovery'
  );
}

function incompleteTaskCategory(
  value: unknown
): FundingTaskIncompleteEvent['taskCategory'] {
  if (value === 'coverage' || value === 'incremental') {
    return value;
  }
  return invalidEventField('taskCategory', 'coverage or incremental');
}

function fundingRateEventName(value: unknown): FundingRateEvent['event'] {
  switch (value) {
    case 'funding_sync_started':
    case 'funding_sync_stopped':
    case 'funding_market_discovery_completed':
    case 'funding_market_discovery_incomplete':
    case 'funding_coverage_started':
    case 'funding_page_committed':
    case 'funding_coverage_completed':
    case 'funding_incremental_completed':
    case 'funding_incremental_blocked':
    case 'funding_request_retry':
    case 'funding_task_incomplete':
    case 'funding_rate_revised':
    case 'funding_sync_fatal':
      return value;
    default:
      return invalidEventField('event', 'an approved event name');
  }
}

function optionalStringQueryField(
  query: UnknownRecord,
  output: Record<string, string | number | boolean>,
  key: typeof APPROVED_QUERY_KEYS[number],
  exactValue?: string
): void {
  const value = optionalOwnValue(query, key, `request.query.${key}`);
  if (
    typeof value === 'string'
    && (exactValue === undefined || value === exactValue)
  ) {
    output[key] = value;
  }
}

function optionalIntegerQueryField(
  query: UnknownRecord,
  output: Record<string, string | number | boolean>,
  key: 'pageNo' | 'pageSize' | 'limit'
): void {
  const value = optionalOwnValue(query, key, `request.query.${key}`);
  if (
    typeof value === 'number'
    && Number.isSafeInteger(value)
    && value >= 0
  ) {
    output[key] = value;
  }
}

function allowlistedQuery(
  value: unknown
): Readonly<Record<string, string | number | boolean>> {
  const query = plainRecord(value, 'request.query');
  const output: Record<string, string | number | boolean> = {};
  optionalStringQueryField(query, output, 'symbol');
  optionalStringQueryField(query, output, 'productType', 'USDT-FUTURES');
  optionalIntegerQueryField(query, output, 'pageNo');
  optionalIntegerQueryField(query, output, 'pageSize');
  optionalStringQueryField(query, output, 'instType', 'SWAP');
  optionalStringQueryField(query, output, 'instId');
  optionalStringQueryField(query, output, 'after');
  optionalIntegerQueryField(query, output, 'limit');
  return output;
}

function allowlistedRequest(value: unknown): FundingRequestMetadata {
  const request = plainRecord(value, 'request');
  const method = ownValue(request, 'method', 'request.method');
  if (method !== 'GET') {
    return invalidEventField('request.method', 'GET');
  }
  return {
    method,
    path: requiredString(
      ownValue(request, 'path', 'request.path'),
      'request.path'
    ),
    query: allowlistedQuery(
      ownValue(request, 'query', 'request.query')
    ),
    body: null
  };
}

function allowlistedCursor(value: unknown): FundingPageCursor {
  const cursor = plainRecord(value, 'cursor');
  const exchangeId = fundingExchangeId(
    ownValue(cursor, 'exchangeId', 'cursor.exchangeId'),
    'cursor.exchangeId'
  );
  if (exchangeId === 'bitget') {
    return {
      exchangeId,
      pageNo: nonNegativeSafeInteger(
        ownValue(cursor, 'pageNo', 'cursor.pageNo'),
        'cursor.pageNo'
      )
    };
  }
  return {
    exchangeId,
    afterMs: nullableNonNegativeSafeInteger(
      ownValue(cursor, 'afterMs', 'cursor.afterMs'),
      'cursor.afterMs'
    )
  };
}

function coverageEventFields(record: UnknownRecord): FundingCoverageEventFields {
  return {
    exchangeId: fundingExchangeId(ownValue(record, 'exchangeId')),
    exchangeMarketId: requiredString(
      ownValue(record, 'exchangeMarketId'),
      'exchangeMarketId'
    ),
    symbol: requiredString(ownValue(record, 'symbol'), 'symbol'),
    phase: requiredString(ownValue(record, 'phase'), 'phase'),
    taskKind: coverageKind(ownValue(record, 'taskKind')),
    generation: nonNegativeSafeInteger(
      ownValue(record, 'generation'),
      'generation'
    )
  };
}

function incrementalEventFields(
  record: UnknownRecord
): FundingIncrementalEventFields {
  return {
    exchangeId: fundingExchangeId(ownValue(record, 'exchangeId')),
    exchangeMarketId: requiredString(
      ownValue(record, 'exchangeMarketId'),
      'exchangeMarketId'
    ),
    symbol: requiredString(ownValue(record, 'symbol'), 'symbol'),
    phase: requiredString(ownValue(record, 'phase'), 'phase'),
    generation: nonNegativeSafeInteger(
      ownValue(record, 'generation'),
      'generation'
    )
  };
}

function requestRetryFields(
  record: UnknownRecord,
  secrets: readonly string[]
): FundingRequestRetryFields {
  return {
    retryAttempt: nonNegativeSafeInteger(
      ownValue(record, 'retryAttempt'),
      'retryAttempt'
    ),
    retryDelayMs: nonNegativeSafeInteger(
      ownValue(record, 'retryDelayMs'),
      'retryDelayMs'
    ),
    request: allowlistedRequest(ownValue(record, 'request')),
    error: allowlistedError(ownValue(record, 'error'), secrets)
  };
}

function fundingRequestRetryEvent(
  record: UnknownRecord,
  secrets: readonly string[]
): FundingRequestRetryEvent {
  const taskCategory = retryTaskCategory(ownValue(record, 'taskCategory'));
  const retryFields = requestRetryFields(record, secrets);
  if (taskCategory === 'coverage') {
    return {
      event: 'funding_request_retry',
      taskCategory,
      ...coverageEventFields(record),
      coverageCutoffMs: nonNegativeSafeInteger(
        ownValue(record, 'coverageCutoffMs'),
        'coverageCutoffMs'
      ),
      cursor: allowlistedCursor(ownValue(record, 'cursor')),
      ...retryFields
    };
  }
  if (taskCategory === 'incremental') {
    return {
      event: 'funding_request_retry',
      taskCategory,
      ...incrementalEventFields(record),
      frozenBoundaryMs: nullableNonNegativeSafeInteger(
        ownValue(record, 'frozenBoundaryMs'),
        'frozenBoundaryMs'
      ),
      cursor: allowlistedCursor(ownValue(record, 'cursor')),
      ...retryFields
    };
  }
  return {
    event: 'funding_request_retry',
    taskCategory,
    exchangeId: fundingExchangeId(ownValue(record, 'exchangeId')),
    phase: requiredString(ownValue(record, 'phase'), 'phase'),
    ...retryFields
  };
}

function fundingTaskIncompleteEvent(
  record: UnknownRecord,
  secrets: readonly string[]
): FundingTaskIncompleteEvent {
  const taskCategory = incompleteTaskCategory(
    ownValue(record, 'taskCategory')
  );
  const request = allowlistedRequest(ownValue(record, 'request'));
  const error = allowlistedError(ownValue(record, 'error'), secrets);
  if (taskCategory === 'coverage') {
    return {
      event: 'funding_task_incomplete',
      taskCategory,
      ...coverageEventFields(record),
      coverageCutoffMs: nonNegativeSafeInteger(
        ownValue(record, 'coverageCutoffMs'),
        'coverageCutoffMs'
      ),
      cursor: allowlistedCursor(ownValue(record, 'cursor')),
      request,
      error
    };
  }
  return {
    event: 'funding_task_incomplete',
    taskCategory,
    ...incrementalEventFields(record),
    frozenBoundaryMs: nullableNonNegativeSafeInteger(
      ownValue(record, 'frozenBoundaryMs'),
      'frozenBoundaryMs'
    ),
    cursor: allowlistedCursor(ownValue(record, 'cursor')),
    request,
    error
  };
}

function allowlistedFundingRateEvent(
  input: Readonly<FundingRateEventInput>,
  secrets: readonly string[]
): FundingRateEvent {
  const record = plainRecord(input, 'input');
  const event = fundingRateEventName(ownValue(record, 'event'));
  switch (event) {
    case 'funding_sync_started':
    case 'funding_sync_stopped':
      return {
        event,
        phase: requiredString(ownValue(record, 'phase'), 'phase')
      };
    case 'funding_market_discovery_completed':
      return {
        event,
        exchangeId: fundingExchangeId(ownValue(record, 'exchangeId')),
        phase: requiredString(ownValue(record, 'phase'), 'phase'),
        observedActiveCount: nonNegativeSafeInteger(
          ownValue(record, 'observedActiveCount'),
          'observedActiveCount'
        ),
        observedInactiveCount: nonNegativeSafeInteger(
          ownValue(record, 'observedInactiveCount'),
          'observedInactiveCount'
        ),
        createdActiveCount: nonNegativeSafeInteger(
          ownValue(record, 'createdActiveCount'),
          'createdActiveCount'
        ),
        becameInactiveCount: nonNegativeSafeInteger(
          ownValue(record, 'becameInactiveCount'),
          'becameInactiveCount'
        ),
        reactivatedCount: nonNegativeSafeInteger(
          ownValue(record, 'reactivatedCount'),
          'reactivatedCount'
        )
      };
    case 'funding_market_discovery_incomplete':
      return {
        event,
        exchangeId: fundingExchangeId(ownValue(record, 'exchangeId')),
        phase: requiredString(ownValue(record, 'phase'), 'phase'),
        request: allowlistedRequest(ownValue(record, 'request')),
        error: allowlistedError(ownValue(record, 'error'), secrets)
      };
    case 'funding_coverage_started':
      return {
        event,
        ...coverageEventFields(record),
        coverageCutoffMs: nonNegativeSafeInteger(
          ownValue(record, 'coverageCutoffMs'),
          'coverageCutoffMs'
        ),
        cursor: allowlistedCursor(ownValue(record, 'cursor'))
      };
    case 'funding_page_committed':
      return {
        event,
        ...coverageEventFields(record),
        cursor: allowlistedCursor(ownValue(record, 'cursor')),
        inserted: nonNegativeSafeInteger(
          ownValue(record, 'inserted'),
          'inserted'
        ),
        unchanged: nonNegativeSafeInteger(
          ownValue(record, 'unchanged'),
          'unchanged'
        ),
        revised: nonNegativeSafeInteger(ownValue(record, 'revised'), 'revised')
      };
    case 'funding_coverage_completed':
      return {
        event,
        ...coverageEventFields(record),
        coverageCutoffMs: nonNegativeSafeInteger(
          ownValue(record, 'coverageCutoffMs'),
          'coverageCutoffMs'
        ),
        lastCaughtUpCutoffMs: nonNegativeSafeInteger(
          ownValue(record, 'lastCaughtUpCutoffMs'),
          'lastCaughtUpCutoffMs'
        )
      };
    case 'funding_incremental_completed':
      return {
        event,
        ...incrementalEventFields(record),
        inserted: nonNegativeSafeInteger(
          ownValue(record, 'inserted'),
          'inserted'
        ),
        unchanged: nonNegativeSafeInteger(
          ownValue(record, 'unchanged'),
          'unchanged'
        ),
        revised: nonNegativeSafeInteger(ownValue(record, 'revised'), 'revised')
      };
    case 'funding_incremental_blocked':
      return { event, ...incrementalEventFields(record) };
    case 'funding_request_retry':
      return fundingRequestRetryEvent(record, secrets);
    case 'funding_task_incomplete':
      return fundingTaskIncompleteEvent(record, secrets);
    case 'funding_rate_revised':
      return {
        event,
        exchangeId: fundingExchangeId(ownValue(record, 'exchangeId')),
        exchangeMarketId: requiredString(
          ownValue(record, 'exchangeMarketId'),
          'exchangeMarketId'
        ),
        symbol: requiredString(ownValue(record, 'symbol'), 'symbol'),
        phase: requiredString(ownValue(record, 'phase'), 'phase'),
        fundingTimestampMs: nonNegativeSafeInteger(
          ownValue(record, 'fundingTimestampMs'),
          'fundingTimestampMs'
        ),
        previousContentHash: requiredString(
          ownValue(record, 'previousContentHash'),
          'previousContentHash'
        ),
        currentContentHash: requiredString(
          ownValue(record, 'currentContentHash'),
          'currentContentHash'
        )
      };
    case 'funding_sync_fatal':
      return {
        event,
        phase: requiredString(ownValue(record, 'phase'), 'phase'),
        error: allowlistedError(ownValue(record, 'error'), secrets)
      };
  }
}

function redactAllowedValue(
  value: unknown,
  secrets: readonly string[]
): unknown {
  if (typeof value === 'string') {
    return redactText(value, secrets);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactAllowedValue(item, secrets));
  }
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        redactAllowedValue(item, secrets)
      ])
    );
  }
  return value;
}

function fundingRateLogger(
  logger: Pick<Logger, 'child' | 'info'>
): Pick<Logger, 'info'> {
  try {
    return logger.child({ component: 'funding-rates' });
  } catch {
    return { info(): void {} };
  }
}

export function fundingRateEvent(
  input: Readonly<FundingSyncStartedEvent>
): FundingSyncStartedEvent;
export function fundingRateEvent(
  input: Readonly<FundingSyncStoppedEvent>
): FundingSyncStoppedEvent;
export function fundingRateEvent(
  input: Readonly<FundingMarketDiscoveryCompletedEvent>
): FundingMarketDiscoveryCompletedEvent;
export function fundingRateEvent(
  input: Readonly<FundingRateEventInputFor<FundingMarketDiscoveryIncompleteEvent>>
): FundingMarketDiscoveryIncompleteEvent;
export function fundingRateEvent(
  input: Readonly<FundingCoverageStartedEvent>
): FundingCoverageStartedEvent;
export function fundingRateEvent(
  input: Readonly<FundingPageCommittedEvent>
): FundingPageCommittedEvent;
export function fundingRateEvent(
  input: Readonly<FundingCoverageCompletedEvent>
): FundingCoverageCompletedEvent;
export function fundingRateEvent(
  input: Readonly<FundingIncrementalCompletedEvent>
): FundingIncrementalCompletedEvent;
export function fundingRateEvent(
  input: Readonly<FundingIncrementalBlockedEvent>
): FundingIncrementalBlockedEvent;
export function fundingRateEvent(
  input: Readonly<FundingRateEventInputFor<FundingCoverageRequestRetryEvent>>
): FundingCoverageRequestRetryEvent;
export function fundingRateEvent(
  input: Readonly<FundingRateEventInputFor<FundingIncrementalRequestRetryEvent>>
): FundingIncrementalRequestRetryEvent;
export function fundingRateEvent(
  input: Readonly<FundingRateEventInputFor<FundingDiscoveryRequestRetryEvent>>
): FundingDiscoveryRequestRetryEvent;
export function fundingRateEvent(
  input: Readonly<FundingRateEventInputFor<FundingCoverageTaskIncompleteEvent>>
): FundingCoverageTaskIncompleteEvent;
export function fundingRateEvent(
  input: Readonly<FundingRateEventInputFor<FundingIncrementalTaskIncompleteEvent>>
): FundingIncrementalTaskIncompleteEvent;
export function fundingRateEvent(
  input: Readonly<FundingRateRevisedEvent>
): FundingRateRevisedEvent;
export function fundingRateEvent(
  input: Readonly<FundingRateEventInputFor<FundingSyncFatalEvent>>
): FundingSyncFatalEvent;
export function fundingRateEvent(
  input: Readonly<FundingRateEventInput>
): FundingRateEvent;
export function fundingRateEvent(
  input: Readonly<FundingRateEventInput>
): FundingRateEvent {
  return allowlistedFundingRateEvent(input, []);
}

export function nonThrowingFundingRateEventSink(
  sink: FundingRateEventSink
): FundingRateEventSink {
  const existing = NON_THROWING_FUNDING_RATE_EVENT_SINKS.get(sink);
  if (existing !== undefined) {
    return existing;
  }
  const wrapped: FundingRateEventSink = {
    record(event): void {
      nonThrowingLogCall(() => sink.record(event));
    }
  };
  NON_THROWING_FUNDING_RATE_EVENT_SINKS.set(sink, wrapped);
  return wrapped;
}

export class PinoFundingRateEventSink implements FundingRateEventSink {
  readonly #logger: Pick<Logger, 'info'>;
  readonly #secretProvider: () => readonly string[];

  constructor(
    logger: Pick<Logger, 'child' | 'info'>,
    secretProvider: () => readonly string[] = () => []
  ) {
    this.#logger = fundingRateLogger(logger);
    this.#secretProvider = secretProvider;
  }

  record(event: Readonly<FundingRateEvent>): void {
    try {
      const secrets = nonEmptySecrets(this.#secretProvider());
      const allowlisted = allowlistedFundingRateEvent(event, secrets);
      const output = redactAllowedValue(allowlisted, secrets);
      nonThrowingLogCall(() => this.#logger.info(output, allowlisted.event));
    } catch {
      // Logging is never allowed to change funding synchronization behavior.
    }
  }
}
