import type { ExchangeGateway } from './exchange-gateway.js';

const SUPPORTED_EXCHANGE_IDS = new Set(['bitget', 'okx']);

function assertSupportedExchangeId(exchangeId: string): void {
  if (!SUPPORTED_EXCHANGE_IDS.has(exchangeId)) {
    throw new Error(`unsupported exchange: ${exchangeId}`);
  }
}

export class ExchangeRegistry {
  private readonly gateways: ReadonlyMap<string, ExchangeGateway>;

  constructor(gateways: ReadonlyMap<string, ExchangeGateway>) {
    const snapshot = new Map(gateways);
    for (const exchangeId of snapshot.keys()) {
      assertSupportedExchangeId(exchangeId);
    }
    for (const [exchangeId, gateway] of snapshot) {
      if (gateway.exchangeId !== exchangeId) {
        throw new Error(
          `gateway identity mismatch for configured exchange ${exchangeId}`
        );
      }
    }
    this.gateways = snapshot;
  }

  get(exchangeId: string): ExchangeGateway {
    assertSupportedExchangeId(exchangeId);
    const gateway = this.gateways.get(exchangeId);
    if (gateway === undefined) {
      throw new Error(`exchange is not configured: ${exchangeId}`);
    }
    if (gateway.exchangeId !== exchangeId) {
      throw new Error(
        `gateway identity mismatch for configured exchange ${exchangeId}`
      );
    }
    return gateway;
  }

  ids(): string[] {
    return [...this.gateways.keys()].sort();
  }
}
