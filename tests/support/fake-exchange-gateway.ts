import type {
  AccountSettings,
  MarketKind,
  MarketRules,
  OrderRequest,
  OrderSnapshot
} from '../../src/domain/types.js';
import { decimal } from '../../src/domain/decimal.js';
import {
  NoOrderSubmittedError,
  type ExchangeGateway
} from '../../src/exchanges/exchange-gateway.js';

export interface FakeMarketLoadOptions {
  readonly reload?: boolean;
}

export interface FakeLoadedMarketSnapshot {
  readonly identity: Readonly<Pick<MarketRules,
    | 'exchangeId'
    | 'symbol'
    | 'marketId'
    | 'kind'
    | 'base'
    | 'quote'
    | 'active'>>;
  quantityRules(): Readonly<Pick<MarketRules,
    | 'amountStep'
    | 'contractSize'
    | 'minBaseAmount'
    | 'maxBaseAmount'
    | 'priceStep'>>;
  notionalRules(): Readonly<Pick<MarketRules,
    'minQuoteNotional' | 'maxQuoteNotional'>>;
  fetchAccountSettings(): Promise<AccountSettings>;
  fetchLastPrice(): Promise<string>;
}

function marketKey(symbol: string, kind: MarketKind): string {
  return `${kind}:${symbol}`;
}

function validateCreateQuantity(baseQuantity: string): void {
  let parsed: ReturnType<typeof decimal>;
  try {
    parsed = decimal(baseQuantity);
  } catch {
    throw new Error('invalid OrderRequest.baseQuantity: must be a decimal');
  }
  if (!parsed.isFinite() || parsed.lte('0')) {
    throw new Error(
      'invalid OrderRequest.baseQuantity: must be finite and greater than zero'
    );
  }
}

function validateCreateMarginMode(request: OrderRequest): void {
  if (
    request.kind === 'swap'
    && request.marginMode !== 'isolated'
    && request.marginMode !== 'cross'
  ) {
    throw new Error(
      'swap order requires a confirmed isolated or cross margin mode'
    );
  }
  if (request.kind === 'spot' && request.marginMode !== undefined) {
    throw new Error('spot order must not include a margin mode');
  }
}

function validateIdentityField(
  context: 'create' | 'fetch' | 'observed',
  field: string,
  actual: string,
  expected: string
): void {
  if (actual !== expected) {
    throw new Error(
      `configured ${context} snapshot conflicts with ${field}: `
      + `expected ${expected}, received ${actual}`
    );
  }
}

function validateCreateSnapshot(
  exchangeId: string,
  request: OrderRequest,
  snapshot: OrderSnapshot
): void {
  validateIdentityField('create', 'exchangeId', snapshot.exchangeId, exchangeId);
  validateIdentityField(
    'create',
    'clientOrderId',
    snapshot.clientOrderId,
    request.clientOrderId
  );
  validateIdentityField('create', 'symbol', snapshot.symbol, request.symbol);
  validateIdentityField('create', 'kind', snapshot.kind, request.kind);
  validateIdentityField('create', 'type', snapshot.type, request.type);
  validateIdentityField('create', 'side', snapshot.side, request.side);
  validateIdentityField(
    'create',
    'requestedBaseQuantity',
    snapshot.requestedBaseQuantity,
    request.baseQuantity
  );
}

function validateFetchSnapshot(
  exchangeId: string,
  exchangeOrderId: string,
  symbol: string,
  kind: MarketKind,
  snapshot: OrderSnapshot
): void {
  validateIdentityField('fetch', 'exchangeId', snapshot.exchangeId, exchangeId);
  validateIdentityField(
    'fetch',
    'exchangeOrderId',
    snapshot.exchangeOrderId,
    exchangeOrderId
  );
  validateIdentityField('fetch', 'symbol', snapshot.symbol, symbol);
  validateIdentityField('fetch', 'kind', snapshot.kind, kind);
}

export class FakeExchangeGateway implements ExchangeGateway {
  readonly markets = new Map<string, MarketRules>();
  readonly lastPrices = new Map<string, string>();
  readonly quantizedPrices = new Map<string, string>();
  readonly balanceRequests: Array<{
    asset: 'USDT';
    kind: MarketKind;
  }> = [];
  readonly marketLoadRequests: Array<{
    symbol: string;
    kind: MarketKind;
    reload: boolean;
  }> = [];
  readonly createdRequests: OrderRequest[] = [];
  readonly createResults: OrderSnapshot[] = [];
  readonly createErrors = new Map<string, Error>();
  readonly fetchResults = new Map<string, OrderSnapshot[]>();
  freeUsdt = '100000';
  accountSettings: AccountSettings = {
    marginMode: 'isolated',
    positionMode: 'hedged',
    leverage: '2'
  };

  readonly #observedOrders: OrderSnapshot[] = [];

  constructor(readonly exchangeId: string) {}

  seedObservedOrder(snapshot: OrderSnapshot): void {
    validateIdentityField(
      'observed',
      'exchangeId',
      snapshot.exchangeId,
      this.exchangeId
    );
    this.#observedOrders.push(snapshot);
  }

  async loadMarket(
    symbol: string,
    kind: MarketKind,
    options: FakeMarketLoadOptions = {}
  ): Promise<MarketRules> {
    this.marketLoadRequests.push({
      symbol,
      kind,
      reload: options.reload === true
    });
    const configured = this.markets.get(marketKey(symbol, kind))
      ?? [...this.markets.values()].find(
        (market) => market.symbol === symbol && market.kind === kind
      );
    if (configured === undefined) {
      throw new Error(`missing market configuration for ${symbol} ${kind}`);
    }
    return configured;
  }

  async loadMarketSnapshot(
    symbol: string,
    kind: MarketKind,
    options: FakeMarketLoadOptions = {}
  ): Promise<FakeLoadedMarketSnapshot> {
    this.marketLoadRequests.push({
      symbol,
      kind,
      reload: options.reload === true
    });
    const configured = this.markets.get(marketKey(symbol, kind))
      ?? [...this.markets.values()].find(
        (candidate) => candidate.symbol === symbol && candidate.kind === kind
      );
    if (configured === undefined) {
      throw new Error(`missing market configuration for ${symbol} ${kind}`);
    }
    const captured = structuredClone(configured);
    return {
      identity: Object.freeze({
        exchangeId: captured.exchangeId,
        symbol: captured.symbol,
        marketId: captured.marketId,
        kind: captured.kind,
        base: captured.base,
        quote: captured.quote,
        active: captured.active
      }),
      quantityRules: () => Object.freeze({
        amountStep: captured.amountStep,
        contractSize: captured.contractSize,
        minBaseAmount: captured.minBaseAmount,
        ...(captured.maxBaseAmount === undefined
          ? {}
          : { maxBaseAmount: captured.maxBaseAmount }),
        priceStep: captured.priceStep
      }),
      notionalRules: () => Object.freeze({
        ...(captured.minQuoteNotional === undefined
          ? {}
          : { minQuoteNotional: captured.minQuoteNotional }),
        ...(captured.maxQuoteNotional === undefined
          ? {}
          : { maxQuoteNotional: captured.maxQuoteNotional })
      }),
      fetchAccountSettings: () => this.fetchAccountSettings(captured.symbol),
      fetchLastPrice: () => this.fetchLastPrice(captured.symbol, captured.kind)
    };
  }

  async quantizePrice(
    symbol: string,
    kind: MarketKind,
    price: string
  ): Promise<string> {
    return this.quantizedPrices.get(marketKey(symbol, kind)) ?? price;
  }

  async fetchFreeBalance(
    asset: 'USDT',
    kind: MarketKind
  ): Promise<string> {
    this.balanceRequests.push({ asset, kind });
    return this.freeUsdt;
  }

  async fetchAccountSettings(_symbol: string): Promise<AccountSettings> {
    return this.accountSettings;
  }

  async fetchLastPrice(symbol: string, kind: MarketKind): Promise<string> {
    const configured = this.lastPrices.get(marketKey(symbol, kind));
    if (configured === undefined) {
      throw new Error(`missing last price configuration for ${symbol} ${kind}`);
    }
    return configured;
  }

  async createOrder(request: OrderRequest): Promise<OrderSnapshot> {
    try {
      validateCreateQuantity(request.baseQuantity);
      validateCreateMarginMode(request);
    } catch {
      throw new NoOrderSubmittedError();
    }
    this.createdRequests.push(request);
    const configured = this.createResults.shift();
    if (configured === undefined) {
      throw new Error(`missing create result for client order ${request.clientOrderId}`);
    }
    validateCreateSnapshot(this.exchangeId, request, configured);
    this.seedObservedOrder(configured);
    const configuredError = this.createErrors.get(request.clientOrderId);
    if (configuredError !== undefined) {
      this.createErrors.delete(request.clientOrderId);
      throw configuredError;
    }
    return configured;
  }

  async fetchOrder(
    exchangeOrderId: string,
    symbol: string,
    kind: MarketKind
  ): Promise<OrderSnapshot> {
    const configured = this.fetchResults.get(exchangeOrderId)?.shift();
    if (configured === undefined) {
      throw new Error(`missing fetch result for exchange order ${exchangeOrderId}`);
    }
    validateFetchSnapshot(
      this.exchangeId,
      exchangeOrderId,
      symbol,
      kind,
      configured
    );
    this.#observedOrders.push(configured);
    return configured;
  }

  async findOrderByClientId(
    clientOrderId: string,
    symbol: string,
    kind: MarketKind
  ): Promise<OrderSnapshot | null> {
    return this.#observedOrders.findLast(
      (snapshot) => (
        snapshot.exchangeId === this.exchangeId
        && snapshot.clientOrderId === clientOrderId
        && snapshot.symbol === symbol
        && snapshot.kind === kind
      )
    ) ?? null;
  }
}
