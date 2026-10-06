import { EventEmitter } from 'node:events';
import Database from 'better-sqlite3';
import { composeService, startService, type SignalTarget } from '../../src/main.js';
import {
  fundingRateEvent,
  type FundingRateEventInput,
  type FundingRateEventSink
} from '../../src/funding-rates/funding-rate-events.js';
import { SqliteFundingRateRepository } from '../../src/storage/sqlite-funding-rate-repository.js';
import { FakeExchangeGateway } from './fake-exchange-gateway.js';
import { FakeFundingRateSource } from './fake-funding-rate-source.js';

export const STATUS_TIME = Date.parse('2026-10-06T08:00:00.000Z');
export const STATUS_HEADERS = { host: '127.0.0.1:3000' };
export const STATUS_SECRET = 'status-test-secret-never-public';

export function runtimeStatusFixture(options: { stopGate?: Promise<void>; listenGate?: Promise<void>; sink?: FundingRateEventSink; databasePath?: string } = {}) {
  const database = new Database(':memory:');
  let repository!: SqliteFundingRateRepository;
  let events!: FundingRateEventSink;
  let now = STATUS_TIME;
  const sources = [new FakeFundingRateSource('bitget', []), new FakeFundingRateSource('okx', [])] as const;
  const composition = composeService({
    env: {
      TRADING_EXCHANGES: 'bitget,okx',
      ...(options.databasePath === undefined ? {} : { TRADING_DATABASE_PATH: options.databasePath }),
      TRADING_BITGET_API_KEY: STATUS_SECRET,
      TRADING_BITGET_SECRET: 'test-bitget-secret',
      TRADING_BITGET_PASSWORD: 'test-bitget-passphrase',
      TRADING_OKX_API_KEY: 'test-okx-key',
      TRADING_OKX_SECRET: 'test-okx-secret',
      TRADING_OKX_PASSWORD: 'test-okx-passphrase'
    },
    databaseFactory: () => database,
    gatewayFactory: (exchange) => new FakeExchangeGateway(exchange),
    fundingRateSourceFactory: () => sources,
    fundingRateRepositoryFactory: (db) => {
      repository = new SqliteFundingRateRepository(db);
      return repository;
    },
    fundingRateNowMs: () => now,
    fundingRateEvents: options.sink ?? { record() {} },
    fundingRateSyncFactory: (syncOptions) => {
      events = syncOptions.events;
      return {
        start: () => events.record(fundingRateEvent({ event: 'funding_sync_started', phase: 'test' })),
        stop: async () => {
          await options.stopGate;
          events.record(fundingRateEvent({ event: 'funding_sync_stopped', phase: 'test' }));
        }
      };
    },
    logger: false
  });
  return {
    composition, database, repository, sources,
    advance: (ms: number) => { now += ms; },
    record: (event: FundingRateEventInput) => events.record(fundingRateEvent(event)),
    start: () => startService(composition, {
      signalTarget: Object.assign(new EventEmitter(), { exitCode: undefined }) as SignalTarget,
      listen: async () => { await composition.server.ready(); await options.listenGate; }
    }),
    close: async () => {
      await composition.monitor.stop();
      await composition.server.close();
      if (database.open) database.close();
    }
  };
}
