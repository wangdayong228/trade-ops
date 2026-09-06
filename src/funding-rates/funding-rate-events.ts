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

interface FundingIncrementalCompletedEvent {
  readonly event: 'funding_incremental_completed';
  readonly exchangeId: FundingExchangeId;
  readonly exchangeMarketId: string;
  readonly symbol: string;
  readonly phase: string;
  readonly generation: number;
  readonly inserted: number;
  readonly unchanged: number;
  readonly revised: number;
}

interface FundingIncrementalBlockedEvent {
  readonly event: 'funding_incremental_blocked';
  readonly exchangeId: FundingExchangeId;
  readonly exchangeMarketId: string;
  readonly symbol: string;
  readonly phase: string;
  readonly generation: number;
}

interface FundingRequestRetryEvent extends FundingCoverageEventFields {
  readonly event: 'funding_request_retry';
  readonly coverageCutoffMs: number;
  readonly cursor: FundingPageCursor;
  readonly retryAttempt: number;
  readonly retryDelayMs: number;
  readonly request: FundingRequestMetadata;
  readonly error: SafeError;
}

interface FundingTaskIncompleteEvent extends FundingCoverageEventFields {
  readonly event: 'funding_task_incomplete';
  readonly coverageCutoffMs: number;
  readonly cursor: FundingPageCursor;
  readonly request: FundingRequestMetadata;
  readonly error: SafeError;
}

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

function allowlistedQuery(
  query: FundingRequestMetadata['query']
): Readonly<Record<string, string | number | boolean>> {
  const output: Record<string, string | number | boolean> = {};
  for (const key of APPROVED_QUERY_KEYS) {
    const value = query[key];
    if (
      typeof value === 'string'
      || typeof value === 'number'
      || typeof value === 'boolean'
    ) {
      output[key] = value;
    }
  }
  return output;
}

function allowlistedRequest(
  request: FundingRequestMetadata
): FundingRequestMetadata {
  return {
    method: request.method,
    path: request.path,
    query: allowlistedQuery(request.query),
    body: null
  };
}

function allowlistedCursor(cursor: FundingPageCursor): FundingPageCursor {
  if ('pageNo' in cursor) {
    return {
      exchangeId: cursor.exchangeId,
      pageNo: cursor.pageNo
    };
  }
  return {
    exchangeId: cursor.exchangeId,
    afterMs: cursor.afterMs
  };
}

function allowlistedFundingRateEvent(
  input: Readonly<FundingRateEventInput>,
  secrets: readonly string[]
): FundingRateEvent {
  switch (input.event) {
    case 'funding_sync_started':
      return { event: input.event, phase: input.phase };
    case 'funding_sync_stopped':
      return { event: input.event, phase: input.phase };
    case 'funding_market_discovery_completed':
      return {
        event: input.event,
        exchangeId: input.exchangeId,
        phase: input.phase
      };
    case 'funding_market_discovery_incomplete':
      return {
        event: input.event,
        exchangeId: input.exchangeId,
        phase: input.phase,
        request: allowlistedRequest(input.request),
        error: allowlistedError(input.error, secrets)
      };
    case 'funding_coverage_started':
      return {
        event: input.event,
        exchangeId: input.exchangeId,
        exchangeMarketId: input.exchangeMarketId,
        symbol: input.symbol,
        phase: input.phase,
        taskKind: input.taskKind,
        generation: input.generation,
        coverageCutoffMs: input.coverageCutoffMs,
        cursor: allowlistedCursor(input.cursor)
      };
    case 'funding_page_committed':
      return {
        event: input.event,
        exchangeId: input.exchangeId,
        exchangeMarketId: input.exchangeMarketId,
        symbol: input.symbol,
        phase: input.phase,
        taskKind: input.taskKind,
        generation: input.generation,
        cursor: allowlistedCursor(input.cursor),
        inserted: input.inserted,
        unchanged: input.unchanged,
        revised: input.revised
      };
    case 'funding_coverage_completed':
      return {
        event: input.event,
        exchangeId: input.exchangeId,
        exchangeMarketId: input.exchangeMarketId,
        symbol: input.symbol,
        phase: input.phase,
        taskKind: input.taskKind,
        generation: input.generation,
        coverageCutoffMs: input.coverageCutoffMs,
        lastCaughtUpCutoffMs: input.lastCaughtUpCutoffMs
      };
    case 'funding_incremental_completed':
      return {
        event: input.event,
        exchangeId: input.exchangeId,
        exchangeMarketId: input.exchangeMarketId,
        symbol: input.symbol,
        phase: input.phase,
        generation: input.generation,
        inserted: input.inserted,
        unchanged: input.unchanged,
        revised: input.revised
      };
    case 'funding_incremental_blocked':
      return {
        event: input.event,
        exchangeId: input.exchangeId,
        exchangeMarketId: input.exchangeMarketId,
        symbol: input.symbol,
        phase: input.phase,
        generation: input.generation
      };
    case 'funding_request_retry':
      return {
        event: input.event,
        exchangeId: input.exchangeId,
        exchangeMarketId: input.exchangeMarketId,
        symbol: input.symbol,
        phase: input.phase,
        taskKind: input.taskKind,
        generation: input.generation,
        coverageCutoffMs: input.coverageCutoffMs,
        cursor: allowlistedCursor(input.cursor),
        retryAttempt: input.retryAttempt,
        retryDelayMs: input.retryDelayMs,
        request: allowlistedRequest(input.request),
        error: allowlistedError(input.error, secrets)
      };
    case 'funding_task_incomplete':
      return {
        event: input.event,
        exchangeId: input.exchangeId,
        exchangeMarketId: input.exchangeMarketId,
        symbol: input.symbol,
        phase: input.phase,
        taskKind: input.taskKind,
        generation: input.generation,
        coverageCutoffMs: input.coverageCutoffMs,
        cursor: allowlistedCursor(input.cursor),
        request: allowlistedRequest(input.request),
        error: allowlistedError(input.error, secrets)
      };
    case 'funding_rate_revised':
      return {
        event: input.event,
        exchangeId: input.exchangeId,
        exchangeMarketId: input.exchangeMarketId,
        symbol: input.symbol,
        phase: input.phase,
        fundingTimestampMs: input.fundingTimestampMs,
        previousContentHash: input.previousContentHash,
        currentContentHash: input.currentContentHash
      };
    case 'funding_sync_fatal':
      return {
        event: input.event,
        phase: input.phase,
        error: allowlistedError(input.error, secrets)
      };
    default:
      throw new Error('unsupported funding rate event');
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
  input: Readonly<FundingRateEventInputFor<FundingRequestRetryEvent>>
): FundingRequestRetryEvent;
export function fundingRateEvent(
  input: Readonly<FundingRateEventInputFor<FundingTaskIncompleteEvent>>
): FundingTaskIncompleteEvent;
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
