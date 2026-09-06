/// <reference types="node" />

import { EventEmitter } from 'node:events';
import { run } from '../../src/main.js';
import {
  SqliteOwnershipError
} from '../../src/storage/sqlite-process-owner.js';
import { OrderMonitor } from '../../src/strategy/order-monitor.js';
import { FakeExchangeGateway } from './fake-exchange-gateway.js';

const [databasePath] = process.argv.slice(2);
if (databasePath === undefined || process.send === undefined) {
  throw new Error('sqlite contender child requires path and IPC');
}

interface ServiceContenderResult {
  readonly kind: 'startup_rejected' | 'unexpectedly_started';
  readonly code?: string;
  readonly gatewayConstructions: number;
  readonly recoveryStarts: number;
  readonly monitorStarts: number;
  readonly listenCalls: number;
}

class ChildSignalTarget extends EventEmitter {
  exitCode: number | undefined;
}

function send(result: ServiceContenderResult): void {
  if (process.send === undefined) {
    throw new Error('sqlite contender child lost its IPC channel');
  }
  process.send(result);
}

let gatewayConstructions = 0;
let recoveryStarts = 0;
let monitorStarts = 0;
let listenCalls = 0;
const originalStart = OrderMonitor.prototype.start;
const originalRecover = OrderMonitor.prototype.recover;
OrderMonitor.prototype.start = function (
  this: OrderMonitor,
  intervalMs: number
): () => void {
  monitorStarts += 1;
  return originalStart.call(this, intervalMs);
};
OrderMonitor.prototype.recover = async function (
  this: OrderMonitor
): Promise<void> {
  recoveryStarts += 1;
  await originalRecover.call(this);
};

try {
  const started = await run({
    env: {
      TRADING_EXCHANGES: 'bitget,okx',
      TRADING_BITGET_API_KEY: 'fixture-bitget-key',
      TRADING_BITGET_SECRET: 'fixture-bitget-secret',
      TRADING_BITGET_PASSWORD: 'fixture-bitget-password',
      TRADING_OKX_API_KEY: 'fixture-okx-key',
      TRADING_OKX_SECRET: 'fixture-okx-secret',
      TRADING_OKX_PASSWORD: 'fixture-okx-password',
      TRADING_DATABASE_PATH: databasePath
    },
    gatewayFactory: (exchangeId) => {
      gatewayConstructions += 1;
      return new FakeExchangeGateway(exchangeId);
    },
    signalTarget: new ChildSignalTarget(),
    listen: async () => {
      listenCalls += 1;
    },
    logger: false
  });
  await started.shutdown();
  send({
    kind: 'unexpectedly_started',
    gatewayConstructions,
    recoveryStarts,
    monitorStarts,
    listenCalls
  });
} catch (error) {
  send({
    kind: 'startup_rejected',
    code: error instanceof SqliteOwnershipError
      ? (error as { readonly code: string }).code
      : 'UNEXPECTED_SAFE_STARTUP_FAILURE',
    gatewayConstructions,
    recoveryStarts,
    monitorStarts,
    listenCalls
  });
} finally {
  OrderMonitor.prototype.start = originalStart;
  OrderMonitor.prototype.recover = originalRecover;
}
process.disconnect?.();
