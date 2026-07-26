import { Decimal } from 'decimal.js';
import { decimal } from '../domain/decimal.js';
import { normalizeCommonBaseQuantity } from '../domain/quantity-normalizer.js';
import type {
  AccountSettings,
  ExecutionMode,
  MarketRules
} from '../domain/types.js';
import type { ExchangeRegistry } from '../exchanges/exchange-registry.js';

export interface PreflightInput {
  spotExchangeId: string;
  contractExchangeId: string;
  symbol: string;
  requestedBaseQuantity: string;
  mode: ExecutionMode;
}

export interface PreflightResult extends PreflightInput {
  effectiveBaseQuantity: string;
  spotMarket: MarketRules;
  contractMarket: MarketRules;
  accountSettings: AccountSettings;
  spotFreeUsdt: string;
  contractFreeUsdt: string;
  spotReferencePrice: string;
  contractReferencePrice: string;
  riskAcknowledgementRequired: true;
  createdAt: string;
}

const EXECUTION_MODES = new Set<ExecutionMode>([
  'CONCURRENT',
  'CONTRACT_FIRST',
  'SPOT_FIRST'
]);

function positiveDecimal(value: unknown, field: string): Decimal {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`invalid ${field}: must be a decimal string`);
  }
  let parsed: Decimal;
  try {
    parsed = decimal(value);
  } catch {
    throw new Error(`invalid ${field}: must be a decimal string`);
  }
  if (!parsed.isFinite() || parsed.lte(0)) {
    throw new Error(`invalid ${field}: must be finite and greater than zero`);
  }
  return parsed;
}

function exactProduct(left: Decimal, right: Decimal, field: string): Decimal {
  const requiredPrecision = left.sd() + right.sd() + 2;
  if (
    !Number.isSafeInteger(requiredPrecision)
    || requiredPrecision > 1_000_000
  ) {
    throw new Error(`invalid ${field}: exact result exceeds supported precision`);
  }
  const ExactDecimal = Decimal.clone({
    precision: Math.max(Decimal.precision, requiredPrecision),
    rounding: Decimal.ROUND_DOWN
  });
  const product = new ExactDecimal(left.toString()).mul(right.toString());
  if (!product.isFinite() || product.lte(0)) {
    throw new Error(`invalid ${field}: must be finite and greater than zero`);
  }
  return decimal(product.toFixed());
}

function assertMarketPair(
  input: PreflightInput,
  spotMarket: MarketRules,
  contractMarket: MarketRules
): void {
  const symbolParts = input.symbol.split('/');
  const expectedBase = symbolParts[0];
  if (
    symbolParts.length !== 2
    || expectedBase === undefined
    || expectedBase === ''
    || symbolParts[1] !== 'USDT'
    || spotMarket.base !== expectedBase
    || contractMarket.base !== expectedBase
    || spotMarket.base !== contractMarket.base
    || spotMarket.quote !== 'USDT'
    || contractMarket.quote !== 'USDT'
  ) {
    throw new Error('markets must use the same base asset and USDT quote');
  }
  if (
    spotMarket.exchangeId !== input.spotExchangeId
    || contractMarket.exchangeId !== input.contractExchangeId
    || spotMarket.symbol !== input.symbol
    || contractMarket.symbol !== input.symbol
  ) {
    throw new Error('market snapshot identity does not match the preflight request');
  }
  if (
    spotMarket.kind !== 'spot'
    || contractMarket.kind !== 'swap'
    || spotMarket.active !== true
    || contractMarket.active !== true
  ) {
    throw new Error(
      'preflight requires an active spot and active linear USDT-settled swap'
    );
  }
}

function confirmedAccountSettings(settings: AccountSettings): {
  settings: AccountSettings;
  leverage: Decimal;
} {
  if (
    settings.marginMode !== 'isolated'
    && settings.marginMode !== 'cross'
  ) {
    throw new Error(
      'confirmed account settings require isolated or cross margin mode'
    );
  }
  if (
    settings.positionMode !== 'one-way'
    && settings.positionMode !== 'hedged'
  ) {
    throw new Error(
      'confirmed account settings require one-way or hedged position mode'
    );
  }
  const leverage = positiveDecimal(settings.leverage, 'contract leverage');
  return {
    settings: {
      marginMode: settings.marginMode,
      positionMode: settings.positionMode,
      leverage: leverage.toFixed()
    },
    leverage
  };
}

function quoteNotionalLimits(
  market: MarketRules,
  leg: 'spot' | 'contract'
): {
  minimum: Decimal | undefined;
  maximum: Decimal | undefined;
} {
  const minimum = market.minQuoteNotional === undefined
    ? undefined
    : positiveDecimal(
      market.minQuoteNotional,
      `${leg} minimum quote notional`
    );
  const maximum = market.maxQuoteNotional === undefined
    ? undefined
    : positiveDecimal(
      market.maxQuoteNotional,
      `${leg} maximum quote notional`
    );
  if (
    minimum !== undefined
    && maximum !== undefined
    && minimum.gt(maximum)
  ) {
    throw new Error(`invalid ${leg} quote notional limits: minimum exceeds maximum`);
  }
  return { minimum, maximum };
}

function assertQuoteNotional(
  notional: Decimal,
  market: MarketRules,
  leg: 'spot' | 'contract'
): void {
  const { minimum, maximum } = quoteNotionalLimits(market, leg);
  if (minimum !== undefined && notional.lt(minimum)) {
    throw new Error(`${leg} quote notional is below the market minimum`);
  }
  if (maximum !== undefined && notional.gt(maximum)) {
    throw new Error(`${leg} quote notional exceeds the market maximum`);
  }
}

export class PreflightService {
  constructor(private readonly registry: ExchangeRegistry) {}

  async run(input: PreflightInput): Promise<PreflightResult> {
    if (!EXECUTION_MODES.has(input.mode)) {
      throw new Error(`unsupported execution mode: ${String(input.mode)}`);
    }
    if (input.spotExchangeId === input.contractExchangeId) {
      throw new Error('spot and contract legs must use different exchanges');
    }

    const spotGateway = this.registry.get(input.spotExchangeId);
    const contractGateway = this.registry.get(input.contractExchangeId);
    const [spotMarket, contractMarket] = await Promise.all([
      spotGateway.loadMarket(input.symbol, 'spot'),
      contractGateway.loadMarket(input.symbol, 'swap')
    ]);
    assertMarketPair(input, spotMarket, contractMarket);

    const effectiveBaseQuantity = normalizeCommonBaseQuantity({
      requestedBaseQuantity: input.requestedBaseQuantity,
      spot: spotMarket,
      swap: contractMarket
    });

    const [
      spotFreeUsdtValue,
      contractFreeUsdtValue,
      accountSettingsValue,
      spotReferencePriceValue,
      contractReferencePriceValue
    ] = await Promise.all([
      spotGateway.fetchFreeBalance('USDT', 'spot'),
      contractGateway.fetchFreeBalance('USDT', 'swap'),
      contractGateway.fetchAccountSettings(input.symbol),
      spotGateway.fetchLastPrice(input.symbol, 'spot'),
      contractGateway.fetchLastPrice(input.symbol, 'swap')
    ]);

    const quantity = positiveDecimal(
      effectiveBaseQuantity,
      'effective base quantity'
    );
    const spotFreeUsdt = positiveDecimal(
      spotFreeUsdtValue,
      'spot USDT balance'
    );
    const contractFreeUsdt = positiveDecimal(
      contractFreeUsdtValue,
      'contract USDT balance'
    );
    const spotReferencePrice = positiveDecimal(
      spotReferencePriceValue,
      'spot reference price'
    );
    const contractReferencePrice = positiveDecimal(
      contractReferencePriceValue,
      'contract reference price'
    );
    const confirmed = confirmedAccountSettings(accountSettingsValue);

    const spotQuoteNotional = exactProduct(
      quantity,
      spotReferencePrice,
      'spot quote notional'
    );
    const contractQuoteNotional = exactProduct(
      quantity,
      contractReferencePrice,
      'contract quote notional'
    );
    assertQuoteNotional(spotQuoteNotional, spotMarket, 'spot');
    assertQuoteNotional(contractQuoteNotional, contractMarket, 'contract');

    if (spotFreeUsdt.lt(spotQuoteNotional)) {
      throw new Error('insufficient spot USDT balance for preflight preview');
    }
    const leveragedContractBalance = exactProduct(
      contractFreeUsdt,
      confirmed.leverage,
      'leveraged contract balance'
    );
    if (leveragedContractBalance.lt(contractQuoteNotional)) {
      throw new Error('insufficient contract USDT balance for preflight preview');
    }

    return {
      ...input,
      effectiveBaseQuantity,
      spotMarket: { ...spotMarket },
      contractMarket: { ...contractMarket },
      accountSettings: confirmed.settings,
      spotFreeUsdt: spotFreeUsdt.toFixed(),
      contractFreeUsdt: contractFreeUsdt.toFixed(),
      spotReferencePrice: spotReferencePrice.toFixed(),
      contractReferencePrice: contractReferencePrice.toFixed(),
      riskAcknowledgementRequired: true,
      createdAt: new Date().toISOString()
    };
  }
}
