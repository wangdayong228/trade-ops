import type {
  AccountSettings,
  MarketKind,
  MarketRules,
  OrderRequest,
  OrderSnapshot
} from '../../src/domain/types.js';
import type { ExchangeGateway } from '../../src/exchanges/exchange-gateway.js';

function marketKey(symbol: string, kind: MarketKind): string {
  return `${kind}:${symbol}`;
}

export class FakeExchangeGateway implements ExchangeGateway {
  readonly markets = new Map<string, MarketRules>();
  readonly lastPrices = new Map<string, string>();
  readonly quantizedPrices = new Map<string, string>();
  readonly createdRequests: OrderRequest[] = [];
  readonly createResults: OrderSnapshot[] = [];
  readonly fetchResults = new Map<string, OrderSnapshot[]>();
  freeUsdt = '100000';
  accountSettings: AccountSettings = {
    marginMode: 'isolated',
    positionMode: 'one-way',
    leverage: '2'
  };

  readonly #observedOrders: OrderSnapshot[] = [];

  constructor(readonly exchangeId: string) {}

  async loadMarket(symbol: string, kind: MarketKind): Promise<MarketRules> {
    const configured = this.markets.get(marketKey(symbol, kind))
      ?? [...this.markets.values()].find(
        (market) => market.symbol === symbol && market.kind === kind
      );
    if (configured === undefined) {
      throw new Error(`missing market configuration for ${symbol} ${kind}`);
    }
    return configured;
  }

  async quantizePrice(
    symbol: string,
    kind: MarketKind,
    price: string
  ): Promise<string> {
    return this.quantizedPrices.get(marketKey(symbol, kind)) ?? price;
  }

  async fetchFreeBalance(_asset: 'USDT'): Promise<string> {
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
    this.createdRequests.push(request);
    const configured = this.createResults.shift();
    if (configured === undefined) {
      throw new Error(`missing create result for client order ${request.clientOrderId}`);
    }
    this.#observedOrders.push(configured);
    return configured;
  }

  async fetchOrder(
    exchangeOrderId: string,
    _symbol: string,
    _kind: MarketKind
  ): Promise<OrderSnapshot> {
    const configured = this.fetchResults.get(exchangeOrderId)?.shift();
    if (configured === undefined) {
      throw new Error(`missing fetch result for exchange order ${exchangeOrderId}`);
    }
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
        snapshot.clientOrderId === clientOrderId
        && snapshot.symbol === symbol
        && snapshot.kind === kind
      )
    ) ?? null;
  }
}
