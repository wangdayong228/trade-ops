/// <reference types="node" />

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test, { type TestContext } from 'node:test';
import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { makeClientOrderId } from '../../src/domain/client-order-id.js';
import type {
  OrderRequest,
  OrderRole,
  OrderSnapshot
} from '../../src/domain/types.js';
import { ExchangeRegistry } from '../../src/exchanges/exchange-registry.js';
import {
  buildServer,
  LOGGER_REDACT_PATHS
} from '../../src/http/server.js';
import { HedgeCoordinator } from '../../src/strategy/hedge-coordinator.js';
import type {
  PreflightInput,
  PreflightResult
} from '../../src/strategy/preflight-service.js';
import { SqliteStrategyRepository } from '../../src/storage/sqlite-strategy-repository.js';
import {
  StrategyNotFoundError,
  type StrategyRepository
} from '../../src/storage/strategy-repository.js';
import { FakeExchangeGateway } from '../support/fake-exchange-gateway.js';

const SYMBOL = 'BTC/USDT';

function preflight(
  overrides: Partial<PreflightResult> = {}
): PreflightResult {
  return {
    spotExchangeId: 'bitget',
    contractExchangeId: 'okx',
    symbol: SYMBOL,
    requestedBaseQuantity: '1',
    effectiveBaseQuantity: '1',
    mode: 'CONTRACT_FIRST',
    spotMarket: {
      exchangeId: 'bitget',
      symbol: SYMBOL,
      marketId: 'BTCUSDT',
      kind: 'spot',
      base: 'BTC',
      quote: 'USDT',
      active: true,
      amountStep: '0.001',
      contractSize: '1',
      minBaseAmount: '0.001',
      minQuoteNotional: '5',
      priceStep: '0.1'
    },
    contractMarket: {
      exchangeId: 'okx',
      symbol: SYMBOL,
      marketId: 'BTC-USDT-SWAP',
      kind: 'swap',
      base: 'BTC',
      quote: 'USDT',
      active: true,
      amountStep: '1',
      contractSize: '0.001',
      minBaseAmount: '0.001',
      minQuoteNotional: '5',
      priceStep: '0.1'
    },
    accountSettings: {
      marginMode: 'isolated',
      positionMode: 'one-way',
      leverage: '2'
    },
    spotFreeUsdt: '100000',
    contractFreeUsdt: '50000',
    spotReferencePrice: '60000',
    contractReferencePrice: '60010',
    riskAcknowledgementRequired: true,
    createdAt: '2026-07-31T00:00:00.000Z',
    ...overrides
  };
}

interface Fixture {
  readonly server: FastifyInstance;
  readonly repository: SqliteStrategyRepository;
  readonly preflightInputs: PreflightInput[];
  readonly getExecutionCount: () => number;
}

function setup(
  t: TestContext,
  options: {
    readonly repository?: StrategyRepository;
    readonly runPreflight?: (
      input: PreflightInput
    ) => Promise<PreflightResult>;
    readonly confirmAndExecute?: (strategyId: string) => Promise<void>;
  } = {}
): Fixture {
  const database = new Database(':memory:');
  const baseRepository = new SqliteStrategyRepository(database);
  const repository = options.repository ?? baseRepository;
  const preflightInputs: PreflightInput[] = [];
  let executionCount = 0;
  const server = buildServer({
    registry: {
      ids: () => ['bitget', 'okx']
    },
    preflightService: {
      run: async (input) => {
        preflightInputs.push(input);
        return options.runPreflight?.(input) ?? preflight(input);
      }
    },
    repository,
    coordinator: {
      confirmAndExecute: async (strategyId) => {
        executionCount += 1;
        await options.confirmAndExecute?.(strategyId);
      }
    },
    logger: false
  });
  t.after(async () => {
    await server.close();
    database.close();
  });
  return {
    server,
    repository: baseRepository,
    preflightInputs,
    getExecutionCount: () => executionCount
  };
}

function requestFor(
  strategyId: string,
  role: OrderRole,
  baseQuantity: string
): OrderRequest {
  const common = {
    symbol: SYMBOL,
    baseQuantity,
    clientOrderId: makeClientOrderId(strategyId, role)
  };
  switch (role) {
    case 'SPOT_MARKET':
      return {
        ...common,
        kind: 'spot',
        type: 'market',
        side: 'buy'
      };
    case 'CONTRACT_MARKET':
      return {
        ...common,
        kind: 'swap',
        type: 'market',
        side: 'sell',
        positionSide: 'SHORT',
        marginMode: 'isolated'
      };
    case 'SPOT_HEDGE_GTC':
      return {
        ...common,
        kind: 'spot',
        type: 'limit',
        side: 'buy',
        price: '60000',
        timeInForce: 'GTC'
      };
    case 'CONTRACT_HEDGE_GTC':
      return {
        ...common,
        kind: 'swap',
        type: 'limit',
        side: 'sell',
        price: '60000',
        timeInForce: 'GTC',
        positionSide: 'SHORT',
        marginMode: 'isolated'
      };
  }
}

function snapshotFor(
  request: OrderRequest,
  exchangeId: string,
  overrides: Partial<OrderSnapshot> = {}
): OrderSnapshot {
  return {
    exchangeId,
    exchangeOrderId: `${exchangeId}-${request.clientOrderId}`,
    clientOrderId: request.clientOrderId,
    symbol: request.symbol,
    kind: request.kind,
    type: request.type,
    side: request.side,
    requestedBaseQuantity: request.baseQuantity,
    filledBaseQuantity: '0',
    remainingBaseQuantity: request.baseQuantity,
    averagePrice: null,
    status: 'open',
    updatedAt: '2026-07-31T00:01:00.000Z',
    ...overrides
  };
}

async function flushImmediate(): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

test('lists only configured exchange ids', async (t) => {
  const { server } = setup(t);

  const response = await server.inject({
    method: 'GET',
    url: '/api/exchanges'
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { exchanges: ['bitget', 'okx'] });
  assert.match(response.headers['cache-control'] ?? '', /no-store/);
});

test('preflight requires exactly five public fields and persists a pending strategy', async (t) => {
  const { server, repository, preflightInputs } = setup(t);
  const payload: PreflightInput = {
    spotExchangeId: 'bitget',
    contractExchangeId: 'okx',
    symbol: SYMBOL,
    requestedBaseQuantity: '1',
    mode: 'CONTRACT_FIRST'
  };

  const response = await server.inject({
    method: 'POST',
    url: '/api/hedges/preflight',
    payload
  });

  assert.equal(response.statusCode, 201);
  assert.deepEqual(preflightInputs, [payload]);
  const body = response.json();
  assert.equal(body.state, 'PENDING_CONFIRMATION');
  assert.equal(body.preflight.riskAcknowledgementRequired, true);
  assert.equal(repository.getStrategy(body.id).state, 'PENDING_CONFIRMATION');
  assert.deepEqual(Object.keys(body).sort(), ['id', 'preflight', 'state']);
  assert.doesNotMatch(response.body, /gateway|credential|api.?key|secret|password/i);
});

test('preflight rejects missing, extra, secret, malformed, and oversized fields without running checks', async (t) => {
  const { server, preflightInputs } = setup(t);
  const valid = {
    spotExchangeId: 'bitget',
    contractExchangeId: 'okx',
    symbol: SYMBOL,
    requestedBaseQuantity: '1',
    mode: 'CONCURRENT'
  };
  const invalidPayloads = [
    {
      spotExchangeId: 'bitget',
      contractExchangeId: 'okx',
      symbol: SYMBOL,
      requestedBaseQuantity: '1'
    },
    { ...valid, extra: 'not-allowed' },
    { ...valid, apiKey: 'LEAK-ME-NOT' },
    { ...valid, secret: 'LEAK-ME-NOT' },
    { ...valid, password: 'LEAK-ME-NOT' },
    { ...valid, signature: 'LEAK-ME-NOT' },
    { ...valid, mode: 'AUTO' },
    { ...valid, requestedBaseQuantity: '-1' },
    { ...valid, requestedBaseQuantity: '1e999999' },
    { ...valid, requestedBaseQuantity: '1'.repeat(257) },
    { ...valid, spotExchangeId: 'x'.repeat(129) }
  ];

  for (const payload of invalidPayloads) {
    const response = await server.inject({
      method: 'POST',
      url: '/api/hedges/preflight',
      payload
    });
    assert.equal(response.statusCode, 400);
    assert.deepEqual(response.json(), {
      code: 'INVALID_REQUEST',
      message: 'Request validation failed'
    });
    assert.doesNotMatch(response.body, /LEAK-ME-NOT/);
  }
  assert.equal(preflightInputs.length, 0);
});

test('preflight failure returns a fixed response without leaking raw errors', async (t) => {
  const { server } = setup(t, {
    runPreflight: async () => {
      throw new Error('apiKey=LEAK-ME-NOT insufficient account 12345');
    }
  });

  const response = await server.inject({
    method: 'POST',
    url: '/api/hedges/preflight',
    payload: {
      spotExchangeId: 'bitget',
      contractExchangeId: 'okx',
      symbol: SYMBOL,
      requestedBaseQuantity: '1',
      mode: 'SPOT_FIRST'
    }
  });

  assert.equal(response.statusCode, 422);
  assert.deepEqual(response.json(), {
    code: 'PREFLIGHT_REJECTED',
    message: 'Preflight checks did not pass'
  });
  assert.doesNotMatch(response.body, /LEAK-ME-NOT|12345/);
});

test('confirmation requires the exact true risk acknowledgement before queueing', async (t) => {
  const { server, repository, getExecutionCount } = setup(t);
  const strategy = repository.createPending(preflight());
  const invalidPayloads = [
    undefined,
    {},
    { riskAcknowledged: false },
    { riskAcknowledged: true, extra: true }
  ];

  for (const payload of invalidPayloads) {
    const response = await server.inject({
      method: 'POST',
      url: `/api/hedges/${strategy.id}/confirm`,
      ...(payload === undefined ? {} : { payload })
    });
    assert.equal(response.statusCode, 400);
  }
  await flushImmediate();
  assert.equal(getExecutionCount(), 0);
  assert.equal(repository.getStrategy(strategy.id).state, 'PENDING_CONFIRMATION');
});

test('confirmation returns 404 for an unknown strategy without queueing', async (t) => {
  const { server, getExecutionCount } = setup(t);

  const response = await server.inject({
    method: 'POST',
    url: '/api/hedges/missing-strategy/confirm',
    payload: { riskAcknowledged: true }
  });

  assert.equal(response.statusCode, 404);
  assert.deepEqual(response.json(), {
    code: 'STRATEGY_NOT_FOUND',
    message: 'Strategy not found'
  });
  await flushImmediate();
  assert.equal(getExecutionCount(), 0);
});

test('two concurrent confirmations queue only one coordinator execution', async (t) => {
  let releaseExecution: (() => void) | undefined;
  const executionGate = new Promise<void>((resolve) => {
    releaseExecution = resolve;
  });
  const fixture = setup(t, {
    confirmAndExecute: async () => executionGate
  });
  const strategy = fixture.repository.createPending(preflight());

  const responses = await Promise.all([
    fixture.server.inject({
      method: 'POST',
      url: `/api/hedges/${strategy.id}/confirm`,
      payload: { riskAcknowledged: true }
    }),
    fixture.server.inject({
      method: 'POST',
      url: `/api/hedges/${strategy.id}/confirm`,
      payload: { riskAcknowledged: true }
    })
  ]);

  assert.deepEqual(
    responses.map((response) => response.statusCode).sort(),
    [202, 202]
  );
  assert.ok(responses.every((response) => (
    response.json().accepted === true
  )));
  await flushImmediate();
  assert.equal(fixture.getExecutionCount(), 1);
  releaseExecution?.();
});

test('two concurrent confirmations create each fake exchange order only once', async (t) => {
  const database = new Database(':memory:');
  const repository = new SqliteStrategyRepository(database);
  const spot = new FakeExchangeGateway('bitget');
  const contract = new FakeExchangeGateway('okx');
  const registry = new ExchangeRegistry(new Map([
    ['bitget', spot],
    ['okx', contract]
  ]));
  const strategy = repository.createPending(preflight());
  const contractRequest = requestFor(
    strategy.id,
    'CONTRACT_MARKET',
    strategy.effectiveBaseQuantity
  );
  const spotRequest = requestFor(
    strategy.id,
    'SPOT_HEDGE_GTC',
    strategy.effectiveBaseQuantity
  );
  contract.createResults.push(snapshotFor(contractRequest, 'okx', {
    filledBaseQuantity: '1',
    remainingBaseQuantity: '0',
    averagePrice: '60010',
    status: 'closed'
  }));
  spot.createResults.push(snapshotFor(spotRequest, 'bitget', {
    filledBaseQuantity: '1',
    remainingBaseQuantity: '0',
    averagePrice: '60010',
    status: 'closed'
  }));
  const server = buildServer({
    registry,
    preflightService: {
      run: async () => {
        throw new Error('not used');
      }
    },
    repository,
    coordinator: new HedgeCoordinator(registry, repository),
    logger: false
  });
  t.after(async () => {
    await server.close();
    database.close();
  });

  const responses = await Promise.all([
    server.inject({
      method: 'POST',
      url: `/api/hedges/${strategy.id}/confirm`,
      payload: { riskAcknowledged: true }
    }),
    server.inject({
      method: 'POST',
      url: `/api/hedges/${strategy.id}/confirm`,
      payload: { riskAcknowledged: true }
    })
  ]);
  await server.close();

  assert.deepEqual(
    responses.map((response) => response.statusCode).sort(),
    [202, 202]
  );
  assert.equal(contract.createdRequests.length, 1);
  assert.equal(spot.createdRequests.length, 1);
  assert.equal(repository.getStrategy(strategy.id).state, 'HEDGED');
});

test('confirmation is an idempotent 202 for terminal strategies without new execution', async (t) => {
  const { server, repository, getExecutionCount } = setup(t);
  const strategy = repository.createPending(preflight());
  assert.equal(repository.claimForExecution(strategy.id), true);
  assert.equal(
    repository.transition(strategy.id, ['EXECUTING'], 'HEDGED'),
    true
  );

  const response = await server.inject({
    method: 'POST',
    url: `/api/hedges/${strategy.id}/confirm`,
    payload: { riskAcknowledged: true }
  });

  assert.equal(response.statusCode, 202);
  assert.deepEqual(response.json(), { accepted: true });
  await flushImmediate();
  assert.equal(getExecutionCount(), 0);
});

test('background coordinator rejection is caught and server close drains queued work', async (t) => {
  let releaseExecution: (() => void) | undefined;
  const executionGate = new Promise<void>((resolve) => {
    releaseExecution = resolve;
  });
  const fixture = setup(t, {
    confirmAndExecute: async () => {
      await executionGate;
      throw new Error('secret rejection detail LEAK-ME-NOT');
    }
  });
  const strategy = fixture.repository.createPending(preflight());
  let unhandledReason: unknown;
  const onUnhandled = (reason: unknown): void => {
    unhandledReason = reason;
  };
  process.once('unhandledRejection', onUnhandled);

  const response = await fixture.server.inject({
    method: 'POST',
    url: `/api/hedges/${strategy.id}/confirm`,
    payload: { riskAcknowledged: true }
  });
  assert.equal(response.statusCode, 202);
  await flushImmediate();

  let closeFinished = false;
  const closePromise = fixture.server.close().then(() => {
    closeFinished = true;
  });
  await flushImmediate();
  assert.equal(closeFinished, false);

  releaseExecution?.();
  await closePromise;
  await flushImmediate();
  process.removeListener('unhandledRejection', onUnhandled);
  assert.equal(unhandledReason, undefined);
});

test('status uses only latest snapshots and preserves exact high precision fills', async (t) => {
  const { server, repository } = setup(t);
  const quantity = '1.0000000000000000000000000000000000000001';
  const strategy = repository.createPending(preflight({
    requestedBaseQuantity: quantity,
    effectiveBaseQuantity: quantity
  }));
  assert.equal(repository.claimForExecution(strategy.id), true);

  const spotRequest = requestFor(strategy.id, 'SPOT_MARKET', quantity);
  const spotOrder = repository.planOrder(
    strategy.id,
    'SPOT_MARKET',
    spotRequest
  );
  repository.attachOrderSnapshot(spotOrder.id, snapshotFor(
    spotRequest,
    'bitget',
    {
      filledBaseQuantity: '0.1000000000000000000000000000000000000001',
      remainingBaseQuantity: '0.9',
      averagePrice: '60000',
      updatedAt: '2026-07-31T00:01:00.000Z'
    }
  ));
  repository.attachOrderSnapshot(spotOrder.id, snapshotFor(
    spotRequest,
    'bitget',
    {
      filledBaseQuantity: '0.9000000000000000000000000000000000000001',
      remainingBaseQuantity: '0.1',
      averagePrice: '60000',
      status: 'closed',
      updatedAt: '2026-07-31T00:02:00.000Z'
    }
  ));

  const contractRequest = requestFor(
    strategy.id,
    'CONTRACT_MARKET',
    quantity
  );
  const contractOrder = repository.planOrder(
    strategy.id,
    'CONTRACT_MARKET',
    contractRequest
  );
  repository.attachOrderSnapshot(contractOrder.id, snapshotFor(
    contractRequest,
    'okx',
    {
      filledBaseQuantity: '0.8999999999999999999999999999999999999999',
      remainingBaseQuantity: '0.1000000000000000000000000000000000000002',
      averagePrice: '60010',
      status: 'closed',
      updatedAt: '2026-07-31T00:02:00.000Z'
    }
  ));

  const response = await server.inject({
    method: 'GET',
    url: `/api/hedges/${strategy.id}`
  });

  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.strategy.id, strategy.id);
  assert.equal(body.preflight.effectiveBaseQuantity, quantity);
  assert.equal(body.orders.length, 2);
  assert.deepEqual(body.actualFills, {
    spotBuyBaseQuantity: '0.9000000000000000000000000000000000000001',
    contractShortBaseQuantity: '0.8999999999999999999999999999999999999999',
    unmatchedBaseQuantity: '0.0000000000000000000000000000000000000002'
  });
  assert.equal(repository.listOrderEvents(spotOrder.id).length, 2);
  assert.match(response.headers['cache-control'] ?? '', /no-store/);
  assert.match(response.headers['content-security-policy'] ?? '', /default-src 'self'/);
});

test('status reports zero actual fills for orders without snapshots', async (t) => {
  const { server, repository } = setup(t);
  const strategy = repository.createPending(preflight());
  assert.equal(repository.claimForExecution(strategy.id), true);
  repository.planOrder(
    strategy.id,
    'SPOT_MARKET',
    requestFor(strategy.id, 'SPOT_MARKET', '1')
  );
  repository.planOrder(
    strategy.id,
    'CONTRACT_MARKET',
    requestFor(strategy.id, 'CONTRACT_MARKET', '1')
  );

  const response = await server.inject({
    method: 'GET',
    url: `/api/hedges/${strategy.id}`
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json().actualFills, {
    spotBuyBaseQuantity: '0',
    contractShortBaseQuantity: '0',
    unmatchedBaseQuantity: '0'
  });
});

test('status returns typed 404 and tampered repository failures return safe 500', async (t) => {
  const first = setup(t);
  const missing = await first.server.inject({
    method: 'GET',
    url: '/api/hedges/missing-strategy'
  });
  assert.equal(missing.statusCode, 404);

  const existing = first.repository.createPending(preflight());
  const tamperedRepository = new Proxy<StrategyRepository>(first.repository, {
    get(target, property, receiver) {
      if (property === 'listOrders') {
        return () => {
          throw new Error('sqlite row secret LEAK-ME-NOT');
        };
      }
      return Reflect.get(target, property, receiver);
    }
  });
  const second = setup(t, { repository: tamperedRepository });

  const tampered = await second.server.inject({
    method: 'GET',
    url: `/api/hedges/${existing.id}`
  });

  assert.equal(tampered.statusCode, 500);
  assert.deepEqual(tampered.json(), {
    code: 'INTERNAL_ERROR',
    message: 'Internal server error'
  });
  assert.doesNotMatch(tampered.body, /LEAK-ME-NOT|sqlite row secret/);
});

test('logger configuration redacts headers, direct secrets, and common nested credentials', () => {
  for (const path of [
    'req.headers.authorization',
    'req.headers.cookie',
    'req.body.apiKey',
    'req.body.secret',
    'req.body.password',
    'req.body.signature',
    'req.body.credentials.apiKey',
    'req.body.credentials.secret',
    'req.body.auth.password',
    'req.body.auth.signature'
  ]) {
    assert.ok(LOGGER_REDACT_PATHS.includes(path));
  }
});

test('operator page has explicit modes, safe acknowledgement, complete rendering, and invalidation contracts', async (t) => {
  const { server } = setup(t);
  const [pageResponse, scriptResponse, styleResponse] = await Promise.all([
    server.inject({ method: 'GET', url: '/' }),
    server.inject({ method: 'GET', url: '/app.js' }),
    server.inject({ method: 'GET', url: '/styles.css' })
  ]);

  assert.equal(pageResponse.statusCode, 200);
  assert.equal(scriptResponse.statusCode, 200);
  assert.equal(styleResponse.statusCode, 200);
  assert.match(pageResponse.headers['content-security-policy'] ?? '', /script-src 'self'/);
  assert.match(pageResponse.headers['cache-control'] ?? '', /no-cache/);

  const page = pageResponse.body;
  const script = scriptResponse.body;
  assert.match(
    page,
    /<option value="" selected disabled>请选择执行模式<\/option>/
  );
  assert.deepEqual(
    [...page.matchAll(/<option value="(CONCURRENT|CONTRACT_FIRST|SPOT_FIRST)">/g)]
      .map((match) => match[1]),
    ['CONCURRENT', 'CONTRACT_FIRST', 'SPOT_FIRST']
  );
  assert.doesNotMatch(
    page,
    /<option value="(?:CONCURRENT|CONTRACT_FIRST|SPOT_FIRST)"[^>]*selected/
  );
  assert.match(page, /我理解顺序模式和差额补单可能长期产生单边敞口/);
  for (const id of [
    'spot-exchange',
    'contract-exchange',
    'symbol',
    'base-quantity',
    'mode',
    'preflight-button',
    'risk-ack',
    'confirm-button',
    'refresh-button',
    'requested-quantity',
    'effective-quantity',
    'spot-price',
    'contract-price',
    'spot-balance',
    'contract-balance',
    'margin-mode',
    'position-mode',
    'leverage',
    'strategy-state',
    'spot-order-ids',
    'contract-order-ids',
    'spot-actual-fill',
    'contract-actual-fill',
    'unmatched-quantity'
  ]) {
    assert.match(page, new RegExp(`id="${id}"`));
  }
  assert.doesNotMatch(page, /api.?key|secret|password/i);
  assert.match(page, /<link rel="stylesheet" href="\/styles\.css">/);
  assert.match(page, /id="base-quantity"[^>]*maxlength="256"/);
  assert.doesNotMatch(script, /innerHTML/);
  assert.match(script, /riskAcknowledged:\s*true/);
  assert.match(script, /input\.addEventListener\('input', invalidatePreflight\)/);
  assert.match(script, /input\.addEventListener\('change', invalidatePreflight\)/);
  assert.match(script, /let inputRevision = 0/);
  assert.match(script, /inputRevision \+= 1/);
  assert.match(script, /const submittedRevision = inputRevision/);
  assert.match(script, /submittedRevision !== inputRevision/);
  assert.match(script, /const statusRevision = inputRevision/);
  assert.match(script, /statusRevision !== inputRevision/);
  assert.match(script, /const confirmationRevision = inputRevision/);
  assert.match(script, /confirmationRevision !== inputRevision/);
  assert.match(script, /strategyId === null/);
  assert.match(script, /确认已受理，正在后台执行/);
  assert.match(script, /\.textContent\s*=/);
});

test('missing strategies use the typed repository error', (t) => {
  const { repository } = setup(t);

  assert.throws(
    () => repository.getStrategy('missing-strategy'),
    StrategyNotFoundError
  );
});
