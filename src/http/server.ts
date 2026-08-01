import { resolve } from 'node:path';
import staticPlugin from '@fastify/static';
import { Decimal } from 'decimal.js';
import Fastify, {
  type FastifyInstance,
  type FastifyServerOptions
} from 'fastify';
import type {
  MarketRules,
  OrderRequest,
  OrderSnapshot
} from '../domain/types.js';
import type { ExchangeRegistry } from '../exchanges/exchange-registry.js';
import type {
  StrategyOrderRecord,
  StrategyRecord,
  StrategyRepository
} from '../storage/strategy-repository.js';
import { StrategyNotFoundError } from '../storage/strategy-repository.js';
import type { HedgeCoordinator } from '../strategy/hedge-coordinator.js';
import type {
  PreflightInput,
  PreflightResult,
  PreflightService
} from '../strategy/preflight-service.js';
import { LOGGER_REDACT_PATHS } from '../logging/logger.js';

export { LOGGER_REDACT_PATHS } from '../logging/logger.js';

export interface BuildServerDependencies {
  readonly registry: Pick<ExchangeRegistry, 'ids'>;
  readonly preflightService: Pick<PreflightService, 'run'>;
  readonly repository: StrategyRepository;
  readonly coordinator: Pick<HedgeCoordinator, 'confirmAndExecute'>;
  readonly logger?: FastifyServerOptions['logger'];
  readonly publicDirectory?: string;
}

const PREFLIGHT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'spotExchangeId',
    'contractExchangeId',
    'symbol',
    'requestedBaseQuantity',
    'mode'
  ],
  properties: {
    spotExchangeId: {
      type: 'string',
      minLength: 1,
      maxLength: 128,
      pattern: '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$'
    },
    contractExchangeId: {
      type: 'string',
      minLength: 1,
      maxLength: 128,
      pattern: '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$'
    },
    symbol: {
      type: 'string',
      minLength: 6,
      maxLength: 64,
      pattern: '^[A-Z0-9][A-Z0-9._-]{0,30}/USDT$'
    },
    requestedBaseQuantity: {
      type: 'string',
      minLength: 1,
      maxLength: 256,
      pattern: '^(?=.*[1-9])(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?$'
    },
    mode: {
      type: 'string',
      enum: ['CONCURRENT', 'CONTRACT_FIRST', 'SPOT_FIRST']
    }
  }
} as const;

const CONFIRM_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['riskAcknowledged'],
  properties: {
    riskAcknowledged: { const: true }
  }
} as const;

const STRATEGY_ID_PARAMS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['id'],
  properties: {
    id: {
      type: 'string',
      minLength: 1,
      maxLength: 128,
      pattern: '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$'
    }
  }
} as const;

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'none'",
  "connect-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "img-src 'self'",
  "object-src 'none'",
  "script-src 'self'",
  "style-src 'self'"
].join('; ');

const MAX_STATUS_PRECISION = 1_000_000;
const MAX_FIXED_EXPONENT = 10_000;
const StatusDecimal = Decimal.clone({
  precision: 80,
  rounding: Decimal.ROUND_DOWN,
  minE: -9_000_000_000_000_000,
  maxE: 9_000_000_000_000_000
});

function publicMarket(market: Readonly<MarketRules>): Record<string, unknown> {
  const result: Record<string, unknown> = {
    exchangeId: market.exchangeId,
    symbol: market.symbol,
    marketId: market.marketId,
    kind: market.kind,
    base: market.base,
    quote: market.quote,
    active: market.active,
    amountStep: market.amountStep,
    contractSize: market.contractSize,
    minBaseAmount: market.minBaseAmount,
    priceStep: market.priceStep
  };
  if (market.maxBaseAmount !== undefined) {
    result.maxBaseAmount = market.maxBaseAmount;
  }
  if (market.minQuoteNotional !== undefined) {
    result.minQuoteNotional = market.minQuoteNotional;
  }
  if (market.maxQuoteNotional !== undefined) {
    result.maxQuoteNotional = market.maxQuoteNotional;
  }
  return result;
}

function publicPreflight(
  value: Readonly<PreflightResult>
): Record<string, unknown> {
  return {
    spotExchangeId: value.spotExchangeId,
    contractExchangeId: value.contractExchangeId,
    symbol: value.symbol,
    requestedBaseQuantity: value.requestedBaseQuantity,
    mode: value.mode,
    effectiveBaseQuantity: value.effectiveBaseQuantity,
    spotMarket: publicMarket(value.spotMarket),
    contractMarket: publicMarket(value.contractMarket),
    accountSettings: {
      marginMode: value.accountSettings.marginMode,
      positionMode: value.accountSettings.positionMode,
      leverage: value.accountSettings.leverage
    },
    spotFreeUsdt: value.spotFreeUsdt,
    contractFreeUsdt: value.contractFreeUsdt,
    spotReferencePrice: value.spotReferencePrice,
    contractReferencePrice: value.contractReferencePrice,
    riskAcknowledgementRequired: value.riskAcknowledgementRequired,
    createdAt: value.createdAt
  };
}

function publicStrategy(
  strategy: Readonly<StrategyRecord>
): Record<string, unknown> {
  return {
    id: strategy.id,
    state: strategy.state,
    mode: strategy.mode,
    spotExchangeId: strategy.spotExchangeId,
    contractExchangeId: strategy.contractExchangeId,
    symbol: strategy.symbol,
    requestedBaseQuantity: strategy.requestedBaseQuantity,
    effectiveBaseQuantity: strategy.effectiveBaseQuantity,
    failureCode: strategy.failureCode,
    createdAt: strategy.createdAt,
    updatedAt: strategy.updatedAt
  };
}

function publicOrderRequest(
  request: Readonly<OrderRequest>
): Record<string, unknown> {
  const result: Record<string, unknown> = {
    symbol: request.symbol,
    kind: request.kind,
    type: request.type,
    side: request.side,
    baseQuantity: request.baseQuantity,
    clientOrderId: request.clientOrderId
  };
  if (request.price !== undefined) {
    result.price = request.price;
  }
  if (request.timeInForce !== undefined) {
    result.timeInForce = request.timeInForce;
  }
  if (request.positionSide !== undefined) {
    result.positionSide = request.positionSide;
  }
  if (request.marginMode !== undefined) {
    result.marginMode = request.marginMode;
  }
  return result;
}

function publicOrderSnapshot(
  snapshot: Readonly<OrderSnapshot>
): Record<string, unknown> {
  return {
    exchangeId: snapshot.exchangeId,
    exchangeOrderId: snapshot.exchangeOrderId,
    clientOrderId: snapshot.clientOrderId,
    symbol: snapshot.symbol,
    kind: snapshot.kind,
    type: snapshot.type,
    side: snapshot.side,
    requestedBaseQuantity: snapshot.requestedBaseQuantity,
    filledBaseQuantity: snapshot.filledBaseQuantity,
    remainingBaseQuantity: snapshot.remainingBaseQuantity,
    averagePrice: snapshot.averagePrice,
    status: snapshot.status,
    updatedAt: snapshot.updatedAt
  };
}

function publicOrder(
  order: Readonly<StrategyOrderRecord>
): Record<string, unknown> {
  return {
    id: order.id,
    strategyId: order.strategyId,
    role: order.role,
    exchangeId: order.exchangeId,
    clientOrderId: order.clientOrderId,
    exchangeOrderId: order.exchangeOrderId,
    request: publicOrderRequest(order.request),
    snapshot: order.snapshot === null
      ? null
      : publicOrderSnapshot(order.snapshot),
    status: order.status,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt
  };
}

function statusDecimal(value: string): Decimal {
  if (value.length === 0 || value.length > 10_000) {
    throw new Error('invalid status quantity');
  }
  let parsed: Decimal;
  try {
    parsed = new StatusDecimal(value);
  } catch {
    throw new Error('invalid status quantity');
  }
  if (!parsed.isFinite() || parsed.isNegative()) {
    throw new Error('invalid status quantity');
  }
  return parsed;
}

function exactStatusConstructor(
  values: readonly string[]
): Decimal.Constructor {
  const parsed = values.map(statusDecimal);
  const highestExponent = Math.max(...parsed.map((value) => value.e));
  const lowestSignificantExponent = Math.min(...parsed.map(
    (value) => value.e - value.sd() + 1
  ));
  const carryDigits = Math.ceil(Math.log10(values.length + 1));
  const requiredPrecision =
    highestExponent - lowestSignificantExponent + carryDigits + 4;
  if (
    !Number.isSafeInteger(requiredPrecision)
    || requiredPrecision <= 0
    || requiredPrecision > MAX_STATUS_PRECISION
  ) {
    throw new Error('status quantity precision exceeds supported range');
  }
  return StatusDecimal.clone({
    precision: Math.max(StatusDecimal.precision, requiredPrecision),
    rounding: Decimal.ROUND_DOWN,
    minE: -9_000_000_000_000_000,
    maxE: 9_000_000_000_000_000
  });
}

function formatStatusDecimal(value: Decimal): string {
  if (
    value.e >= -MAX_FIXED_EXPONENT
    && value.e <= MAX_FIXED_EXPONENT
  ) {
    return value.toFixed();
  }
  return value.toString();
}

function exactSum(values: readonly string[]): string {
  if (values.length === 0) {
    return '0';
  }
  const ExactDecimal = exactStatusConstructor(values);
  let total = new ExactDecimal(0);
  for (const value of values) {
    total = total.plus(value);
  }
  return formatStatusDecimal(total);
}

function exactAbsoluteDifference(left: string, right: string): string {
  const ExactDecimal = exactStatusConstructor([left, right]);
  return formatStatusDecimal(
    new ExactDecimal(left).minus(right).abs()
  );
}

function actualFills(
  orders: readonly StrategyOrderRecord[]
): {
  spotBuyBaseQuantity: string;
  contractShortBaseQuantity: string;
  unmatchedBaseQuantity: string;
} {
  const spotFills: string[] = [];
  const contractFills: string[] = [];
  for (const order of orders) {
    const snapshot = order.snapshot;
    if (snapshot === null) {
      continue;
    }
    if (snapshot.kind === 'spot' && snapshot.side === 'buy') {
      spotFills.push(snapshot.filledBaseQuantity);
    }
    if (
      snapshot.kind === 'swap'
      && snapshot.side === 'sell'
      && order.request.positionSide === 'SHORT'
    ) {
      contractFills.push(snapshot.filledBaseQuantity);
    }
  }
  const spotBuyBaseQuantity = exactSum(spotFills);
  const contractShortBaseQuantity = exactSum(contractFills);
  return {
    spotBuyBaseQuantity,
    contractShortBaseQuantity,
    unmatchedBaseQuantity: exactAbsoluteDifference(
      spotBuyBaseQuantity,
      contractShortBaseQuantity
    )
  };
}

function errorProperty(
  error: unknown,
  property: 'code' | 'validation'
): unknown {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }
  try {
    return Reflect.get(error, property);
  } catch {
    return undefined;
  }
}

interface LoopbackAuthority {
  readonly hostname: 'localhost' | '127.0.0.1' | '[::1]';
  readonly port: number;
}

const LOCAL_HTTP_PROTOCOL = 'http';

function loopbackAuthority(
  value: unknown,
  protocol: string
): LoopbackAuthority | null {
  if (typeof value !== 'string') {
    return null;
  }
  const match = /^(localhost|127\.0\.0\.1|\[::1\])(?::([0-9]{1,5}))?$/i
    .exec(value);
  if (match === null) {
    return null;
  }
  const rawHostname = match[1];
  if (rawHostname === undefined) {
    return null;
  }
  const hostname = rawHostname.toLowerCase() as LoopbackAuthority['hostname'];
  const rawPort = match[2];
  const port = rawPort === undefined
    ? protocol === 'https' ? 443 : 80
    : Number(rawPort);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    return null;
  }
  return { hostname, port };
}

function matchingLoopbackOrigin(
  value: unknown,
  requestAuthority: Readonly<LoopbackAuthority>,
  requestProtocol: 'http' | 'https'
): boolean {
  if (typeof value !== 'string' || value === 'null') {
    return false;
  }
  const match = /^(https?):\/\/(.+)$/i.exec(value);
  if (match === null) {
    return false;
  }
  const protocol = match[1]?.toLowerCase();
  const authority = match[2];
  if (
    authority === undefined
    || (protocol !== 'http' && protocol !== 'https')
    || protocol !== requestProtocol
  ) {
    return false;
  }
  const originAuthority = loopbackAuthority(authority, protocol);
  return (
    originAuthority !== null
    && originAuthority.hostname === requestAuthority.hostname
    && originAuthority.port === requestAuthority.port
  );
}

export function buildServer(
  dependencies: BuildServerDependencies
): FastifyInstance {
  const app = Fastify({
    logger: dependencies.logger ?? {
      redact: [...LOGGER_REDACT_PATHS]
    },
    ajv: {
      customOptions: {
        coerceTypes: false,
        removeAdditional: false
      }
    }
  });
  const queuedStrategyIds = new Set<string>();
  const backgroundTasks = new Set<Promise<void>>();

  function queueConfirmation(strategyId: string): void {
    if (queuedStrategyIds.has(strategyId)) {
      return;
    }
    queuedStrategyIds.add(strategyId);
    let task: Promise<void>;
    task = new Promise<void>((resolveTask) => {
      setImmediate(resolveTask);
    })
      .then(async () => dependencies.coordinator.confirmAndExecute(strategyId))
      .catch(() => {
        app.log.error('Background hedge execution failed');
      })
      .finally(() => {
        queuedStrategyIds.delete(strategyId);
        backgroundTasks.delete(task);
      });
    backgroundTasks.add(task);
  }

  app.addHook('onRequest', async (request, reply) => {
    // This server is the cleartext local-HTTP boundary. Task 9 must bind it
    // only to loopback; proxy headers never upgrade or replace this tuple.
    const requestAuthority = loopbackAuthority(
      request.headers.host,
      LOCAL_HTTP_PROTOCOL
    );
    const isStateChangingPost = request.method === 'POST';
    const origin = request.headers.origin;
    const fetchSite = request.headers['sec-fetch-site'];
    const forbidden = (
      requestAuthority === null
      || (
        isStateChangingPost
        && (
          !matchingLoopbackOrigin(
            origin,
            requestAuthority,
            LOCAL_HTTP_PROTOCOL
          )
          || (
            typeof fetchSite === 'string'
            && fetchSite.toLowerCase() === 'cross-site'
          )
        )
      )
    );
    if (forbidden) {
      return reply.status(403).send({
        code: 'FORBIDDEN',
        message: 'Request forbidden'
      });
    }
  });

  app.addHook('onSend', async (request, reply) => {
    reply.header('Content-Security-Policy', CONTENT_SECURITY_POLICY);
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    if (request.url.startsWith('/api/')) {
      reply.header('Cache-Control', 'no-store');
      reply.header('Pragma', 'no-cache');
    } else {
      reply.header('Cache-Control', 'no-cache');
    }
  });

  app.addHook('onClose', async () => {
    await Promise.allSettled([...backgroundTasks]);
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof StrategyNotFoundError) {
      void reply.status(404).send({
        code: 'STRATEGY_NOT_FOUND',
        message: 'Strategy not found'
      });
      return;
    }
    if (
      errorProperty(error, 'validation') !== undefined
      || errorProperty(error, 'code') === 'FST_ERR_CTP_INVALID_JSON_BODY'
    ) {
      void reply.status(400).send({
        code: 'INVALID_REQUEST',
        message: 'Request validation failed'
      });
      return;
    }
    app.log.error('Unhandled HTTP request failure');
    void reply.status(500).send({
      code: 'INTERNAL_ERROR',
      message: 'Internal server error'
    });
  });

  app.get('/api/exchanges', async () => ({
    exchanges: dependencies.registry.ids()
  }));

  app.post<{ Body: PreflightInput }>(
    '/api/hedges/preflight',
    { schema: { body: PREFLIGHT_SCHEMA } },
    async (request, reply) => {
      let preview: PreflightResult;
      try {
        preview = await dependencies.preflightService.run(request.body);
      } catch {
        return reply.status(422).send({
          code: 'PREFLIGHT_REJECTED',
          message: 'Preflight checks did not pass'
        });
      }
      const strategy = dependencies.repository.createPending(preview);
      return reply.status(201).send({
        id: strategy.id,
        state: strategy.state,
        preflight: publicPreflight(strategy.preflight)
      });
    }
  );

  app.post<{
    Params: { id: string };
    Body: { riskAcknowledged: true };
  }>(
    '/api/hedges/:id/confirm',
    {
      schema: {
        params: STRATEGY_ID_PARAMS_SCHEMA,
        body: CONFIRM_SCHEMA
      }
    },
    async (request, reply) => {
      const strategy = dependencies.repository.getStrategy(request.params.id);
      if (
        strategy.state === 'PENDING_CONFIRMATION'
        || strategy.state === 'EXECUTING'
      ) {
        queueConfirmation(strategy.id);
      }
      return reply.status(202).send({ accepted: true });
    }
  );

  app.get<{ Params: { id: string } }>(
    '/api/hedges/:id',
    { schema: { params: STRATEGY_ID_PARAMS_SCHEMA } },
    async (request) => {
      const strategy = dependencies.repository.getStrategy(request.params.id);
      const orders = dependencies.repository.listOrders(strategy.id);
      return {
        strategy: publicStrategy(strategy),
        preflight: publicPreflight(strategy.preflight),
        orders: orders.map(publicOrder),
        actualFills: actualFills(orders)
      };
    }
  );

  void app.register(staticPlugin, {
    root: dependencies.publicDirectory ?? resolve(process.cwd(), 'public'),
    index: 'index.html'
  });

  return app;
}
