/// <reference types="node" />

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import { makeClientOrderId } from '../../src/domain/client-order-id.js';
import type {
  MarketKind,
  MarketRules,
  OrderRequest,
  OrderRole,
  OrderSnapshot,
  StrategyState
} from '../../src/domain/types.js';
import { ExchangeRegistry } from '../../src/exchanges/exchange-registry.js';
import type { TradeEvent } from '../../src/logging/trade-events.js';
import { composeService } from '../../src/main.js';
import { claimSqliteProcessOwnership } from '../../src/storage/sqlite-process-owner.js';
import { SqliteStrategyRepository } from '../../src/storage/sqlite-strategy-repository.js';
import { HedgeCoordinator } from '../../src/strategy/hedge-coordinator.js';
import { HedgeReconciliation } from '../../src/strategy/hedge-reconciliation.js';
import { OrderMonitor } from '../../src/strategy/order-monitor.js';
import type { PreflightResult } from '../../src/strategy/preflight-service.js';
import { FakeExchangeGateway } from '../support/fake-exchange-gateway.js';

const SYMBOL = 'BTC/USDT';
const LOCAL_HEADERS = {
  host: '127.0.0.1:3000',
  origin: 'http://127.0.0.1:3000',
  'sec-fetch-site': 'same-origin'
} as const;
const ENV = {
  TRADING_EXCHANGES: 'bitget,okx',
  TRADING_BITGET_API_KEY: 'fake-bitget-key',
  TRADING_BITGET_SECRET: 'fake-bitget-secret',
  TRADING_BITGET_PASSWORD: 'fake-bitget-password',
  TRADING_OKX_API_KEY: 'fake-okx-key',
  TRADING_OKX_SECRET: 'fake-okx-secret',
  TRADING_OKX_PASSWORD: 'fake-okx-password',
  HOST: '127.0.0.1',
  PORT: '3000'
} as const;

function market(
  exchangeId: 'bitget' | 'okx',
  kind: MarketKind
): MarketRules {
  return {
    exchangeId,
    symbol: SYMBOL,
    marketId: kind === 'spot' ? 'BTCUSDT' : 'BTC-USDT-SWAP',
    kind,
    base: 'BTC',
    quote: 'USDT',
    active: true,
    amountStep: kind === 'spot' ? '0.001' : '1',
    contractSize: kind === 'spot' ? '1' : '0.001',
    minBaseAmount: '0.001',
    minQuoteNotional: '5',
    priceStep: '0.1'
  };
}

function snapshot(
  strategyId: string,
  role: OrderRole,
  overrides: Partial<OrderSnapshot>
): OrderSnapshot {
  const spot = role.startsWith('SPOT');
  const limit = role.endsWith('GTC');
  return {
    exchangeId: spot ? 'bitget' : 'okx',
    exchangeOrderId: `${role.toLowerCase()}-1`,
    clientOrderId: makeClientOrderId(strategyId, role),
    symbol: SYMBOL,
    kind: spot ? 'spot' : 'swap',
    type: limit ? 'limit' : 'market',
    side: spot ? 'buy' : 'sell',
    requestedBaseQuantity: '1',
    filledBaseQuantity: '0',
    remainingBaseQuantity: '1',
    averagePrice: null,
    status: 'open',
    updatedAt: '2026-07-31T08:00:00.000Z',
    ...overrides
  };
}

function recoveryRequest(
  strategyId: string,
  role: OrderRole,
  baseQuantity: string
): OrderRequest {
  const clientOrderId = makeClientOrderId(strategyId, role);
  if (role === 'SPOT_MARKET') {
    return {
      symbol: SYMBOL,
      kind: 'spot',
      type: 'market',
      side: 'buy',
      baseQuantity,
      clientOrderId
    };
  }
  if (role === 'CONTRACT_MARKET') {
    return {
      symbol: SYMBOL,
      kind: 'swap',
      type: 'market',
      side: 'sell',
      baseQuantity,
      clientOrderId,
      positionSide: 'SHORT',
      marginMode: 'cross'
    };
  }
  if (role === 'CONTRACT_HEDGE_GTC') {
    return {
      symbol: SYMBOL,
      kind: 'swap',
      type: 'limit',
      side: 'sell',
      baseQuantity,
      price: '60000',
      timeInForce: 'GTC',
      clientOrderId,
      positionSide: 'SHORT',
      marginMode: 'cross'
    };
  }
  throw new Error('this recovery fixture only supports a contract GTC');
}

function recoveryPreflight(): PreflightResult {
  return {
    spotExchangeId: 'bitget',
    contractExchangeId: 'okx',
    symbol: SYMBOL,
    requestedBaseQuantity: '1',
    effectiveBaseQuantity: '1',
    mode: 'CONCURRENT',
    spotMarket: market('bitget', 'spot'),
    contractMarket: market('okx', 'swap'),
    accountSettings: {
      marginMode: 'cross',
      positionMode: 'hedged',
      leverage: '2'
    },
    spotFreeUsdt: '100000',
    contractFreeUsdt: '50000',
    spotReferencePrice: '60000',
    contractReferencePrice: '60010',
    riskAcknowledgementRequired: true,
    createdAt: '2026-09-05T00:00:00.000Z'
  };
}

async function waitForState(
  repository: {
    getStrategy(id: string): { state: StrategyState };
  },
  strategyId: string,
  expected: StrategyState
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (repository.getStrategy(strategyId).state === expected) {
      return;
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.equal(repository.getStrategy(strategyId).state, expected);
}

test(
  'operator confirms contract-first and restart recovery reaches HEDGED',
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'trade-ops-acceptance-'));
    const databasePath = join(directory, 'trade-ops.sqlite');
    const spot = new FakeExchangeGateway('bitget');
    const contract = new FakeExchangeGateway('okx');
    spot.markets.set(`spot:${SYMBOL}`, market('bitget', 'spot'));
    contract.markets.set(`swap:${SYMBOL}`, market('okx', 'swap'));
    spot.lastPrices.set(`spot:${SYMBOL}`, '60000');
    contract.lastPrices.set(`swap:${SYMBOL}`, '60010');
    spot.quantizedPrices.set(`spot:${SYMBOL}`, '60010');
    contract.accountSettings = {
      marginMode: 'isolated',
      positionMode: 'hedged',
      leverage: '2'
    };
    const gatewayFactory = (exchangeId: string) => (
      exchangeId === 'bitget' ? spot : contract
    );
    const compositionOptions = {
      env: {
        ...ENV,
        TRADING_DATABASE_PATH: databasePath
      },
      gatewayFactory,
      clock: () => new Date('2026-07-31T07:59:00.000Z'),
      logger: false as const
    };
    const initial = composeService(compositionOptions);
    let restarted: ReturnType<typeof composeService> | undefined;
    t.after(async () => {
      if (restarted !== undefined) {
        await restarted.server.close();
        restarted.database.close();
      } else {
        await initial.server.close();
        initial.database.close();
      }
      await rm(directory, { recursive: true, force: true });
    });

    const preflightResponse = await initial.server.inject({
      method: 'POST',
      url: '/api/hedges/preflight',
      headers: LOCAL_HEADERS,
      payload: {
        spotExchangeId: 'bitget',
        contractExchangeId: 'okx',
        symbol: SYMBOL,
        requestedBaseQuantity: '1',
        mode: 'CONTRACT_FIRST'
      }
    });
    assert.equal(preflightResponse.statusCode, 201);
    const preflightBody = preflightResponse.json<{
      id: string;
      state: StrategyState;
      preflight: { createdAt: string };
    }>();
    assert.equal(preflightBody.state, 'PENDING_CONFIRMATION');
    assert.equal(
      preflightBody.preflight.createdAt,
      '2026-07-31T07:59:00.000Z'
    );

    contract.createResults.push(snapshot(
      preflightBody.id,
      'CONTRACT_MARKET',
      {
        exchangeOrderId: 'contract-market-1',
        requestedBaseQuantity: '1',
        filledBaseQuantity: '0.4',
        remainingBaseQuantity: '0.6',
        averagePrice: '60010',
        status: 'closed'
      }
    ));
    spot.createResults.push(snapshot(
      preflightBody.id,
      'SPOT_HEDGE_GTC',
      {
        exchangeOrderId: 'spot-gtc-1',
        requestedBaseQuantity: '0.4',
        filledBaseQuantity: '0',
        remainingBaseQuantity: '0.4',
        averagePrice: null,
        status: 'open'
      }
    ));

    const confirmResponses = await Promise.all([
      initial.server.inject({
        method: 'POST',
        url: `/api/hedges/${preflightBody.id}/confirm`,
        headers: LOCAL_HEADERS,
        payload: { riskAcknowledged: true }
      }),
      initial.server.inject({
        method: 'POST',
        url: `/api/hedges/${preflightBody.id}/confirm`,
        headers: LOCAL_HEADERS,
        payload: { riskAcknowledged: true }
      })
    ]);
    assert.deepEqual(
      confirmResponses.map((response) => response.statusCode),
      [202, 202]
    );
    assert.deepEqual(
      confirmResponses.map((response) => response.json()),
      [{ accepted: true }, { accepted: true }]
    );
    await waitForState(
      initial.repository,
      preflightBody.id,
      'WAITING_HEDGE'
    );

    const initialOrders = initial.repository.listOrders(preflightBody.id);
    assert.deepEqual(
      initialOrders.map((order) => ({
        role: order.role,
        requested: order.request.baseQuantity,
        filled: order.snapshot?.filledBaseQuantity,
        average: order.snapshot?.averagePrice
      })),
      [
        {
          role: 'CONTRACT_MARKET',
          requested: '1',
          filled: '0.4',
          average: '60010'
        },
        {
          role: 'SPOT_HEDGE_GTC',
          requested: '0.4',
          filled: '0',
          average: null
        }
      ]
    );
    assert.equal(contract.createdRequests.length, 1);
    assert.equal(spot.createdRequests.length, 1);
    assert.equal(
      new Set(initialOrders.map((order) => order.clientOrderId)).size,
      initialOrders.length
    );

    spot.fetchResults.set('spot-gtc-1', [
      snapshot(preflightBody.id, 'SPOT_HEDGE_GTC', {
        exchangeOrderId: 'spot-gtc-1',
        requestedBaseQuantity: '0.4',
        filledBaseQuantity: '0.1',
        remainingBaseQuantity: '0.3',
        averagePrice: '60010',
        status: 'open',
        updatedAt: '2026-07-31T08:01:00.000Z'
      }),
      snapshot(preflightBody.id, 'SPOT_HEDGE_GTC', {
        exchangeOrderId: 'spot-gtc-1',
        requestedBaseQuantity: '0.4',
        filledBaseQuantity: '0.4',
        remainingBaseQuantity: '0',
        averagePrice: '60010',
        status: 'closed',
        updatedAt: '2026-07-31T08:02:00.000Z'
      })
    ]);

    await initial.server.close();
    initial.database.close();
    restarted = composeService(compositionOptions);

    await restarted.monitor.recover();
    assert.equal(
      restarted.repository.getStrategy(preflightBody.id).state,
      'WAITING_HEDGE'
    );
    let statusResponse = await restarted.server.inject({
      method: 'GET',
      url: `/api/hedges/${preflightBody.id}`,
      headers: { host: LOCAL_HEADERS.host }
    });
    assert.equal(statusResponse.statusCode, 200);
    assert.deepEqual(statusResponse.json<{
      actualFills: Record<string, string>;
    }>().actualFills, {
      spotBuyBaseQuantity: '0.1',
      contractShortBaseQuantity: '0.4',
      unmatchedBaseQuantity: '0.3'
    });

    await restarted.monitor.recover();
    assert.equal(
      restarted.repository.getStrategy(preflightBody.id).state,
      'HEDGED'
    );
    statusResponse = await restarted.server.inject({
      method: 'GET',
      url: `/api/hedges/${preflightBody.id}`,
      headers: { host: LOCAL_HEADERS.host }
    });
    assert.equal(statusResponse.statusCode, 200);
    assert.deepEqual(statusResponse.json<{
      actualFills: Record<string, string>;
    }>().actualFills, {
      spotBuyBaseQuantity: '0.4',
      contractShortBaseQuantity: '0.4',
      unmatchedBaseQuantity: '0'
    });
    assert.equal(contract.createdRequests.length, 1);
    assert.equal(spot.createdRequests.length, 1);
    assert.deepEqual(
      restarted.repository.listOrders(preflightBody.id).map((order) => ({
        role: order.role,
        clientOrderId: order.clientOrderId,
        exchangeOrderId: order.exchangeOrderId
      })),
      initialOrders.map((order) => ({
        role: order.role,
        clientOrderId: order.clientOrderId,
        exchangeOrderId: order.exchangeOrderId
      }))
    );
  }
);

const RESTART_GTC_CASES = [
  {
    name: 'closed',
    remote: {
      status: 'closed',
      filledBaseQuantity: '0.4',
      remainingBaseQuantity: '0',
      averagePrice: '60000'
    },
    expectedState: 'HEDGED',
    expectedFailureCode: null,
    expectedGtcEvents: 2,
    expectedTerminalEvents: 1
  },
  {
    name: 'rejected',
    remote: {
      status: 'rejected',
      filledBaseQuantity: '0',
      remainingBaseQuantity: '0.4',
      averagePrice: null
    },
    expectedState: 'HEDGE_INCOMPLETE',
    expectedFailureCode: 'HEDGE_ORDER_REJECTED',
    expectedGtcEvents: 2,
    expectedTerminalEvents: 1
  },
  {
    name: 'canceled partial',
    remote: {
      status: 'canceled',
      filledBaseQuantity: '0.1',
      remainingBaseQuantity: '0.3',
      averagePrice: '60000'
    },
    expectedState: 'HEDGE_INCOMPLETE',
    expectedFailureCode: 'HEDGE_ORDER_CANCELED',
    expectedGtcEvents: 2,
    expectedTerminalEvents: 1
  },
  {
    name: 'lookup failure',
    remote: null,
    expectedState: 'WAITING_HEDGE',
    expectedFailureCode: null,
    expectedGtcEvents: 1,
    expectedTerminalEvents: 0
  }
] as const;

for (const testCase of RESTART_GTC_CASES) {
  test(`restart reconciles ${testCase.name} GTC without submission`, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'trade-ops-restart-'));
    const databasePath = join(directory, 'recovery.sqlite');
    let initialDatabase: Database.Database | undefined = new Database(
      databasePath,
      { timeout: 0 }
    );
    let restartedDatabase: Database.Database | undefined;
    t.after(async () => {
      if (restartedDatabase?.open === true) restartedDatabase.close();
      if (initialDatabase?.open === true) initialDatabase.close();
      await rm(directory, { recursive: true, force: true });
    });
    claimSqliteProcessOwnership(initialDatabase, databasePath);
    const initialRepository = new SqliteStrategyRepository(initialDatabase);
    const strategyId = initialRepository.createPending(recoveryPreflight()).id;
    assert.equal(initialRepository.claimForExecution(strategyId), true);
    const [spotMarket, contractMarket] =
      initialRepository.planOrdersAtomically(strategyId, [
        {
          role: 'SPOT_MARKET',
          request: recoveryRequest(strategyId, 'SPOT_MARKET', '1')
        },
        {
          role: 'CONTRACT_MARKET',
          request: recoveryRequest(strategyId, 'CONTRACT_MARKET', '1')
        }
      ]);
    assert.ok(spotMarket);
    assert.ok(contractMarket);
    initialRepository.attachOrderSnapshot(spotMarket.id, snapshot(
      strategyId,
      'SPOT_MARKET',
      {
        exchangeOrderId: 'spot-market-restart',
        requestedBaseQuantity: '1',
        filledBaseQuantity: '1',
        remainingBaseQuantity: '0',
        averagePrice: '60000',
        status: 'closed'
      }
    ));
    initialRepository.attachOrderSnapshot(contractMarket.id, snapshot(
      strategyId,
      'CONTRACT_MARKET',
      {
        exchangeOrderId: 'contract-market-restart',
        requestedBaseQuantity: '1',
        filledBaseQuantity: '0.6',
        remainingBaseQuantity: '0.4',
        averagePrice: '60010',
        status: 'closed'
      }
    ));
    const gtc = initialRepository.planOrder(
      strategyId,
      'CONTRACT_HEDGE_GTC',
      recoveryRequest(strategyId, 'CONTRACT_HEDGE_GTC', '0.4')
    );
    initialRepository.attachOrderSnapshot(gtc.id, snapshot(
      strategyId,
      'CONTRACT_HEDGE_GTC',
      {
        exchangeOrderId: 'contract-gtc-restart',
        requestedBaseQuantity: '0.4',
        filledBaseQuantity: '0',
        remainingBaseQuantity: '0.4',
        averagePrice: null,
        status: 'open'
      }
    ));
    assert.equal(initialRepository.transition(
      strategyId,
      ['EXECUTING'],
      'WAITING_HEDGE'
    ), true);
    initialDatabase.close();
    initialDatabase = undefined;

    restartedDatabase = new Database(databasePath, { timeout: 0 });
    claimSqliteProcessOwnership(restartedDatabase, databasePath);
    const restartedRepository = new SqliteStrategyRepository(
      restartedDatabase
    );
    const restartedSpot = new FakeExchangeGateway('bitget');
    const restartedContract = new FakeExchangeGateway('okx');
    restartedSpot.markets.set(`spot:${SYMBOL}`, market('bitget', 'spot'));
    restartedContract.markets.set(
      `swap:${SYMBOL}`,
      market('okx', 'swap')
    );
    restartedSpot.fetchResults.set('spot-market-restart', [snapshot(
      strategyId,
      'SPOT_MARKET',
      {
        exchangeOrderId: 'spot-market-restart',
        requestedBaseQuantity: '1',
        filledBaseQuantity: '1',
        remainingBaseQuantity: '0',
        averagePrice: '60000',
        status: 'closed'
      }
    )]);
    restartedContract.fetchResults.set('contract-market-restart', [snapshot(
      strategyId,
      'CONTRACT_MARKET',
      {
        exchangeOrderId: 'contract-market-restart',
        requestedBaseQuantity: '1',
        filledBaseQuantity: '0.6',
        remainingBaseQuantity: '0.4',
        averagePrice: '60010',
        status: 'closed'
      }
    )]);
    if (testCase.remote !== null) {
      restartedContract.fetchResults.set('contract-gtc-restart', [snapshot(
        strategyId,
        'CONTRACT_HEDGE_GTC',
        {
          exchangeOrderId: 'contract-gtc-restart',
          requestedBaseQuantity: '0.4',
          updatedAt: '2026-09-05T00:02:00.000Z',
          ...testCase.remote
        }
      )]);
    }
    const registry = new ExchangeRegistry(new Map([
      ['bitget', restartedSpot],
      ['okx', restartedContract]
    ]));
    const restartedTradeEvents: TradeEvent[] = [];
    const reconciliation = new HedgeReconciliation(
      registry,
      restartedRepository,
      {
        record(event): void {
          restartedTradeEvents.push(structuredClone(event));
        }
      }
    );
    const coordinator = new HedgeCoordinator(
      registry,
      restartedRepository,
      reconciliation
    );
    const monitor = new OrderMonitor(
      restartedRepository,
      coordinator
    );

    await monitor.recover();

    const persisted = restartedRepository.getStrategy(strategyId);
    assert.equal(persisted.state, testCase.expectedState);
    assert.equal(persisted.failureCode, testCase.expectedFailureCode);
    assert.equal(restartedSpot.createdRequests.length, 0);
    assert.equal(restartedContract.createdRequests.length, 0);
    assert.equal(
      restartedRepository.listOrderEvents(gtc.id).length,
      testCase.expectedGtcEvents
    );
    assert.equal(
      restartedTradeEvents.filter(
        ({ event }) => event === 'order_terminal'
      ).length,
      testCase.expectedTerminalEvents
    );
  });
}

test(
  'restarted monitor automatically continues only the persisted sequential intent',
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'trade-ops-resume-'));
    const databasePath = join(directory, 'trade-ops.sqlite');
    const spot = new FakeExchangeGateway('bitget');
    const contract = new FakeExchangeGateway('okx');
    spot.markets.set(`spot:${SYMBOL}`, market('bitget', 'spot'));
    contract.markets.set(`swap:${SYMBOL}`, market('okx', 'swap'));
    spot.lastPrices.set(`spot:${SYMBOL}`, '60000');
    contract.lastPrices.set(`swap:${SYMBOL}`, '60010');
    spot.quantizedPrices.set(`spot:${SYMBOL}`, '60010');
    const options = {
      env: {
        ...ENV,
        TRADING_DATABASE_PATH: databasePath
      },
      gatewayFactory: (exchangeId: string) => (
        exchangeId === 'bitget' ? spot : contract
      ),
      clock: () => new Date('2026-07-31T07:59:00.000Z'),
      logger: false as const
    };
    const initial = composeService(options);
    let restarted: ReturnType<typeof composeService> | undefined;
    t.after(async () => {
      if (restarted !== undefined) {
        await restarted.server.close();
        restarted.database.close();
      } else {
        await initial.server.close();
        initial.database.close();
      }
      await rm(directory, { recursive: true, force: true });
    });

    const preflightResponse = await initial.server.inject({
      method: 'POST',
      url: '/api/hedges/preflight',
      headers: LOCAL_HEADERS,
      payload: {
        spotExchangeId: 'bitget',
        contractExchangeId: 'okx',
        symbol: SYMBOL,
        requestedBaseQuantity: '1',
        mode: 'CONTRACT_FIRST'
      }
    });
    assert.equal(preflightResponse.statusCode, 201);
    const strategyId = preflightResponse.json<{ id: string }>().id;
    assert.equal(initial.repository.claimForExecution(strategyId), true);
    const contractRequest: OrderRequest = {
      symbol: SYMBOL,
      kind: 'swap',
      type: 'market',
      side: 'sell',
      baseQuantity: '1',
      clientOrderId: makeClientOrderId(strategyId, 'CONTRACT_MARKET'),
      positionSide: 'SHORT',
      marginMode: 'isolated'
    };
    initial.repository.planOrder(
      strategyId,
      'CONTRACT_MARKET',
      contractRequest
    );
    contract.seedObservedOrder(snapshot(
      strategyId,
      'CONTRACT_MARKET',
      {
        exchangeOrderId: 'contract-resume-1',
        requestedBaseQuantity: '1',
        filledBaseQuantity: '0.4',
        remainingBaseQuantity: '0.6',
        averagePrice: '60010',
        status: 'closed'
      }
    ));
    spot.createResults.push(snapshot(
      strategyId,
      'SPOT_HEDGE_GTC',
      {
        exchangeOrderId: 'spot-resume-1',
        requestedBaseQuantity: '0.4',
        filledBaseQuantity: '0.4',
        remainingBaseQuantity: '0',
        averagePrice: '60010',
        status: 'closed'
      }
    ));
    await initial.server.close();
    initial.database.close();
    restarted = composeService(options);

    const loaded = await restarted.server.inject({
      method: 'GET',
      url: `/api/hedges/${strategyId}`,
      headers: { host: LOCAL_HEADERS.host }
    });
    assert.equal(loaded.statusCode, 200);
    assert.equal(loaded.json().strategy.state, 'EXECUTING');
    assert.deepEqual(
      loaded.json().orders.map((order: { role: string }) => order.role),
      ['CONTRACT_MARKET']
    );

    await restarted.monitor.recover();
    await waitForState(restarted.repository, strategyId, 'HEDGED');

    await restarted.monitor.recover();

    assert.equal(contract.createdRequests.length, 0);
    assert.equal(spot.createdRequests.length, 1);
    assert.deepEqual(
      restarted.repository.listOrders(strategyId).map((order) => order.role),
      ['CONTRACT_MARKET', 'SPOT_HEDGE_GTC']
    );
    assert.equal(
      new Set(
        restarted.repository.listOrders(strategyId)
          .map((order) => order.clientOrderId)
      ).size,
      2
    );
  }
);
