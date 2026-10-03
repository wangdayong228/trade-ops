import { Decimal } from 'decimal.js';
import { decimal } from '../domain/decimal.js';
import {
  baseStepFor,
  normalizeCommonBaseQuantity
} from '../domain/quantity-normalizer.js';
import type {
  AccountSettings,
  ExecutionMode,
  MarketKind,
  MarketRules
} from '../domain/types.js';
import {
  createTradeOpsError,
  safeFailureCategory,
  withErrorPhase,
  type ErrorCode,
  type ErrorPhase,
  type ErrorSubject,
  type SafeDiagnosticValue,
  type TradeOpsError
} from '../errors/trade-ops-error.js';
import type {
  ExchangeGateway,
  LoadedMarketSnapshot,
  MarketIdentity,
  MarketNotionalRules,
  MarketQuantityRules
} from '../exchanges/exchange-gateway.js';
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

type PreflightPhase = Extract<ErrorPhase, 'preflight' | 'confirmation'>;

const EXECUTION_MODES = new Set<ExecutionMode>([
  'CONCURRENT',
  'CONTRACT_FIRST',
  'SPOT_FIRST'
]);
const EXCHANGE_ID_PATTERN = /^[a-z0-9-]+$/u;
const SYMBOL_PATTERN = /^[A-Z0-9]+\/USDT$/u;
const QUANTITY_PATTERN = /^(?:0|[1-9]\d*)(?:\.\d+)?$/u;

function failure(
  code: ErrorCode,
  subject: ErrorSubject,
  expected: SafeDiagnosticValue,
  actual: SafeDiagnosticValue
): TradeOpsError {
  return createTradeOpsError({
    code,
    phase: 'preflight',
    subject,
    expected,
    actual
  });
}

function trustedFailure(
  error: unknown,
  phase: PreflightPhase = 'preflight'
): TradeOpsError | undefined {
  try {
    return withErrorPhase(error as TradeOpsError, phase);
  } catch {
    return undefined;
  }
}

function requestActual(value: unknown): SafeDiagnosticValue {
  if (value === null || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : 'non-finite number';
  }
  if (typeof value === 'string') {
    return value.length <= 200 ? value : `string length ${value.length}`;
  }
  return `${typeof value} value`;
}

function decimalActual(value: unknown): SafeDiagnosticValue {
  if (value === null) {
    return null;
  }
  if (typeof value !== 'string' && typeof value !== 'number') {
    return `${typeof value} value`;
  }
  const text = String(value).trim();
  if (text === '') {
    return 'empty string';
  }
  try {
    const parsed = decimal(text);
    return parsed.isFinite() ? parsed.toFixed() : 'non-finite decimal';
  } catch {
    return 'malformed decimal';
  }
}

function observedText(value: unknown): SafeDiagnosticValue {
  if (typeof value === 'string') {
    return value.length <= 200 ? value : `string length ${value.length}`;
  }
  if (typeof value === 'boolean' || value === null) {
    return value;
  }
  return `${typeof value} value`;
}

function marketSubject(
  exchangeId: string,
  symbol: string,
  kind: MarketKind,
  field?: string
): ErrorSubject {
  return {
    type: 'market',
    exchangeId,
    symbol,
    kind,
    ...(field === undefined ? {} : { field })
  };
}

function accountSubject(
  exchangeId: string,
  symbol: string,
  field: string
): ErrorSubject {
  return { type: 'account', exchangeId, symbol, field };
}

function parsedDecimal(value: unknown): Decimal | undefined {
  if (
    (typeof value !== 'string' && typeof value !== 'number')
    || String(value).trim() === ''
  ) {
    return undefined;
  }
  try {
    const parsed = decimal(String(value));
    return parsed.isFinite() ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function requestSnapshot(input: PreflightInput): Readonly<PreflightInput> {
  return Object.freeze({
    spotExchangeId: input.spotExchangeId,
    contractExchangeId: input.contractExchangeId,
    symbol: input.symbol,
    requestedBaseQuantity: input.requestedBaseQuantity,
    mode: input.mode
  });
}

function validateRequest(request: Readonly<PreflightInput>): void {
  for (const [field, value] of [
    ['spotExchangeId', request.spotExchangeId],
    ['contractExchangeId', request.contractExchangeId]
  ] as const) {
    if (
      typeof value !== 'string'
      || value.length === 0
      || value.length > 128
      || !EXCHANGE_ID_PATTERN.test(value)
    ) {
      throw failure(
        'REQUEST_FIELD_INVALID',
        { type: 'request', field },
        'lowercase exchange identifier up to 128 characters',
        requestActual(value)
      );
    }
  }
  if (
    typeof request.symbol !== 'string'
    || request.symbol.length > 64
    || !SYMBOL_PATTERN.test(request.symbol)
  ) {
    throw failure(
      'REQUEST_FIELD_INVALID',
      { type: 'request', field: 'symbol' },
      'uppercase BASE/USDT symbol up to 64 characters',
      requestActual(request.symbol)
    );
  }
  if (
    typeof request.requestedBaseQuantity !== 'string'
    || request.requestedBaseQuantity.length > 256
    || !QUANTITY_PATTERN.test(request.requestedBaseQuantity)
  ) {
    throw failure(
      'REQUEST_FIELD_INVALID',
      { type: 'request', field: 'requestedBaseQuantity' },
      'plain unsigned decimal string up to 256 characters',
      requestActual(request.requestedBaseQuantity)
    );
  }
  if (!EXECUTION_MODES.has(request.mode)) {
    throw failure(
      'REQUEST_FIELD_INVALID',
      { type: 'request', field: 'mode' },
      [...EXECUTION_MODES],
      requestActual(request.mode)
    );
  }
  if (request.spotExchangeId === request.contractExchangeId) {
    throw failure(
      'REQUEST_FIELD_INVALID',
      { type: 'request', field: 'contractExchangeId' },
      'different from spotExchangeId',
      request.contractExchangeId
    );
  }
}

function configuredGateway(
  registry: ExchangeRegistry,
  configuredIds: ReadonlySet<string>,
  exchangeId: string
): ExchangeGateway {
  if (!configuredIds.has(exchangeId)) {
    throw failure(
      'EXCHANGE_NOT_CONFIGURED',
      { type: 'exchange', exchangeId, operation: 'preflight configuration' },
      'configured gateway',
      'not configured'
    );
  }
  try {
    return registry.get(exchangeId);
  } catch (error) {
    const known = trustedFailure(error);
    if (known !== undefined) {
      throw known;
    }
    throw failure(
      'EXCHANGE_NOT_CONFIGURED',
      { type: 'exchange', exchangeId, operation: 'gateway lookup' },
      'configured identity-matched gateway',
      safeFailureCategory(error)
    );
  }
}

async function loadSnapshot(
  gateway: ExchangeGateway,
  exchangeId: string,
  symbol: string,
  kind: MarketKind
): Promise<LoadedMarketSnapshot> {
  try {
    return await gateway.loadMarketSnapshot(symbol, kind, { reload: true });
  } catch (error) {
    const known = trustedFailure(error);
    if (known !== undefined) {
      throw known;
    }
    throw failure(
      'MARKET_UNAVAILABLE',
      marketSubject(exchangeId, symbol, kind),
      'successful forced market refresh',
      safeFailureCategory(error)
    );
  }
}

function validateIdentity(
  identity: Readonly<MarketIdentity>,
  exchangeId: string,
  symbol: string,
  kind: MarketKind
): void {
  for (const [field, expected, actual] of [
    ['exchangeId', exchangeId, identity.exchangeId],
    ['symbol', symbol, identity.symbol],
    ['kind', kind, identity.kind]
  ] as const) {
    if (actual !== expected) {
      throw failure(
        'MARKET_IDENTITY_MISMATCH',
        marketSubject(exchangeId, symbol, kind, field),
        expected,
        observedText(actual)
      );
    }
  }
  if (identity.active !== true) {
    throw failure(
      'MARKET_INACTIVE',
      marketSubject(exchangeId, symbol, kind, 'active'),
      true,
      identity.active === false ? false : observedText(identity.active)
    );
  }
}

function validateMarketPair(
  request: Readonly<PreflightInput>,
  spot: Readonly<MarketIdentity>,
  contract: Readonly<MarketIdentity>
): void {
  const expectedBase = request.symbol.slice(0, -'/USDT'.length);
  if (spot.base !== expectedBase) {
    throw failure(
      'MARKET_IDENTITY_MISMATCH',
      marketSubject(request.spotExchangeId, request.symbol, 'spot', 'base'),
      expectedBase,
      observedText(spot.base)
    );
  }
  if (contract.base !== expectedBase || contract.base !== spot.base) {
    throw failure(
      'MARKET_IDENTITY_MISMATCH',
      marketSubject(request.contractExchangeId, request.symbol, 'swap', 'base'),
      expectedBase,
      observedText(contract.base)
    );
  }
  if (spot.quote !== 'USDT') {
    throw failure(
      'MARKET_IDENTITY_MISMATCH',
      marketSubject(request.spotExchangeId, request.symbol, 'spot', 'quote'),
      'USDT',
      observedText(spot.quote)
    );
  }
  if (contract.quote !== 'USDT') {
    throw failure(
      'MARKET_IDENTITY_MISMATCH',
      marketSubject(request.contractExchangeId, request.symbol, 'swap', 'quote'),
      'USDT',
      observedText(contract.quote)
    );
  }
}

async function readAccountSettings(
  snapshot: LoadedMarketSnapshot,
  exchangeId: string,
  symbol: string
): Promise<{ settings: AccountSettings; leverage: Decimal }> {
  let settings: AccountSettings;
  try {
    settings = await snapshot.fetchAccountSettings();
  } catch (error) {
    const known = trustedFailure(error);
    if (known !== undefined) {
      throw known;
    }
    throw failure(
      'ACCOUNT_SETTINGS_UNAVAILABLE',
      accountSubject(exchangeId, symbol, 'settings'),
      'successful account settings read',
      safeFailureCategory(error)
    );
  }
  if (settings.positionMode !== 'hedged') {
    throw failure(
      'ACCOUNT_POSITION_MODE_MISMATCH',
      accountSubject(exchangeId, symbol, 'positionMode'),
      'hedged',
      observedText(settings.positionMode)
    );
  }
  if (settings.marginMode !== 'isolated' && settings.marginMode !== 'cross') {
    throw failure(
      'ACCOUNT_MARGIN_MODE_MISMATCH',
      accountSubject(exchangeId, symbol, 'marginMode'),
      ['isolated', 'cross'],
      observedText(settings.marginMode)
    );
  }
  const leverage = parsedDecimal(settings.leverage);
  if (leverage === undefined || leverage.lte(0)) {
    throw failure(
      'ACCOUNT_LEVERAGE_MISMATCH',
      accountSubject(exchangeId, symbol, 'leverage'),
      'finite decimal greater than zero',
      decimalActual(settings.leverage)
    );
  }
  return {
    settings: Object.freeze({
      marginMode: settings.marginMode,
      positionMode: settings.positionMode,
      leverage: leverage.toFixed()
    }),
    leverage
  };
}

function validRuleDecimal(
  value: unknown,
  exchangeId: string,
  symbol: string,
  kind: MarketKind,
  field: string,
  minimum: 'positive' | 'non-negative'
): string {
  const parsed = parsedDecimal(value);
  const valid = parsed !== undefined && (
    minimum === 'positive' ? parsed.gt(0) : parsed.gte(0)
  );
  if (!valid || parsed === undefined) {
    throw failure(
      'MARKET_RULE_INVALID',
      marketSubject(exchangeId, symbol, kind, field),
      minimum === 'positive'
        ? 'finite decimal greater than zero'
        : 'finite non-negative decimal',
      decimalActual(value)
    );
  }
  return parsed.toFixed();
}

function validateQuantityRules(
  rules: Readonly<MarketQuantityRules>,
  exchangeId: string,
  symbol: string,
  kind: MarketKind
): Readonly<MarketQuantityRules> {
  const amountStep = validRuleDecimal(
    rules.amountStep, exchangeId, symbol, kind, 'amountStep', 'positive'
  );
  const contractSize = validRuleDecimal(
    rules.contractSize, exchangeId, symbol, kind, 'contractSize', 'positive'
  );
  const minBaseAmount = validRuleDecimal(
    rules.minBaseAmount, exchangeId, symbol, kind, 'minBaseAmount', 'non-negative'
  );
  const maxBaseAmount = rules.maxBaseAmount === undefined
    ? undefined
    : validRuleDecimal(
      rules.maxBaseAmount,
      exchangeId,
      symbol,
      kind,
      'maxBaseAmount',
      'positive'
    );
  const priceStep = validRuleDecimal(
    rules.priceStep, exchangeId, symbol, kind, 'priceStep', 'positive'
  );
  if (
    maxBaseAmount !== undefined
    && decimal(minBaseAmount).gt(maxBaseAmount)
  ) {
    throw failure(
      'MARKET_RULE_INVALID',
      marketSubject(exchangeId, symbol, kind, 'baseAmountRange'),
      'minimum less than or equal to maximum',
      'minimum exceeds maximum'
    );
  }
  try {
    baseStepFor({
      amountStep,
      contractSize,
      minBaseAmount,
      ...(maxBaseAmount === undefined ? {} : { maxBaseAmount })
    });
  } catch (error) {
    throw failure(
      'MARKET_RULE_INVALID',
      marketSubject(exchangeId, symbol, kind, 'baseStep'),
      'finite positive derived base step',
      safeFailureCategory(error)
    );
  }
  return Object.freeze({
    amountStep,
    contractSize,
    minBaseAmount,
    ...(maxBaseAmount === undefined ? {} : { maxBaseAmount }),
    priceStep
  });
}

function readQuantityRules(
  snapshot: LoadedMarketSnapshot,
  exchangeId: string,
  symbol: string,
  kind: MarketKind
): Readonly<MarketQuantityRules> {
  let rules: Readonly<MarketQuantityRules>;
  try {
    rules = snapshot.quantityRules();
  } catch (error) {
    const known = trustedFailure(error);
    if (known !== undefined) {
      throw known;
    }
    throw failure(
      'MARKET_RULE_INVALID',
      marketSubject(exchangeId, symbol, kind, 'quantityRules'),
      'valid quantity rule snapshot',
      safeFailureCategory(error)
    );
  }
  return validateQuantityRules(rules, exchangeId, symbol, kind);
}

function effectiveQuantity(
  request: Readonly<PreflightInput>,
  spotRules: Readonly<MarketQuantityRules>,
  contractRules: Readonly<MarketQuantityRules>
): string {
  const requested = parsedDecimal(request.requestedBaseQuantity);
  if (requested === undefined || requested.lte(0)) {
    throw failure(
      'QUANTITY_INVALID',
      marketSubject(request.spotExchangeId, request.symbol, 'spot', 'amount'),
      'finite decimal greater than zero',
      decimalActual(request.requestedBaseQuantity)
    );
  }
  for (const [exchangeId, kind, minimum] of [
    [request.spotExchangeId, 'spot', spotRules.minBaseAmount],
    [request.contractExchangeId, 'swap', contractRules.minBaseAmount]
  ] as const) {
    if (requested.lt(minimum)) {
      throw failure(
        'QUANTITY_OUT_OF_RANGE',
        marketSubject(exchangeId, request.symbol, kind, 'amount'),
        `at least ${minimum}`,
        requested.toFixed()
      );
    }
  }
  try {
    return normalizeCommonBaseQuantity({
      requestedBaseQuantity: request.requestedBaseQuantity,
      spot: spotRules,
      swap: contractRules
    });
  } catch {
    throw failure(
      'QUANTITY_OUT_OF_RANGE',
      marketSubject(request.spotExchangeId, request.symbol, 'spot', 'amount'),
      'quantity aligned to both market steps and within both ranges',
      decimalActual(request.requestedBaseQuantity)
    );
  }
}

async function readPrice(
  snapshot: LoadedMarketSnapshot,
  exchangeId: string,
  symbol: string,
  kind: MarketKind
): Promise<Decimal> {
  let value: string;
  try {
    value = await snapshot.fetchLastPrice();
  } catch (error) {
    const known = trustedFailure(error);
    if (known !== undefined) {
      throw known;
    }
    throw failure(
      'PRICE_UNAVAILABLE',
      marketSubject(exchangeId, symbol, kind, 'price'),
      'successful reference price read',
      safeFailureCategory(error)
    );
  }
  const parsed = parsedDecimal(value);
  if (parsed === undefined || parsed.lte(0)) {
    throw failure(
      'PRICE_INVALID',
      marketSubject(exchangeId, symbol, kind, 'price'),
      'finite decimal greater than zero',
      decimalActual(value)
    );
  }
  return parsed;
}

function readNotionalRules(
  snapshot: LoadedMarketSnapshot,
  exchangeId: string,
  symbol: string,
  kind: MarketKind
): Readonly<MarketNotionalRules> {
  let rules: Readonly<MarketNotionalRules>;
  try {
    rules = snapshot.notionalRules();
  } catch (error) {
    const known = trustedFailure(error);
    if (known !== undefined) {
      throw known;
    }
    throw failure(
      'MARKET_RULE_INVALID',
      marketSubject(exchangeId, symbol, kind, 'notionalRules'),
      'valid notional rule snapshot',
      safeFailureCategory(error)
    );
  }
  const minQuoteNotional = rules.minQuoteNotional === undefined
    ? undefined
    : validRuleDecimal(
      rules.minQuoteNotional,
      exchangeId,
      symbol,
      kind,
      'minQuoteNotional',
      'positive'
    );
  const maxQuoteNotional = rules.maxQuoteNotional === undefined
    ? undefined
    : validRuleDecimal(
      rules.maxQuoteNotional,
      exchangeId,
      symbol,
      kind,
      'maxQuoteNotional',
      'positive'
    );
  if (
    minQuoteNotional !== undefined
    && maxQuoteNotional !== undefined
    && decimal(minQuoteNotional).gt(maxQuoteNotional)
  ) {
    throw failure(
      'MARKET_RULE_INVALID',
      marketSubject(exchangeId, symbol, kind, 'quoteNotionalRange'),
      'minimum less than or equal to maximum',
      'minimum exceeds maximum'
    );
  }
  return Object.freeze({
    ...(minQuoteNotional === undefined ? {} : { minQuoteNotional }),
    ...(maxQuoteNotional === undefined ? {} : { maxQuoteNotional })
  });
}

function exactProduct(left: Decimal, right: Decimal): Decimal {
  const requiredPrecision = left.sd() + right.sd() + 2;
  if (
    !Number.isSafeInteger(requiredPrecision)
    || requiredPrecision > 1_000_000
  ) {
    throw new Error('exact product exceeds supported precision');
  }
  const ExactDecimal = Decimal.clone({
    precision: Math.max(Decimal.precision, requiredPrecision),
    rounding: Decimal.ROUND_DOWN
  });
  return new ExactDecimal(left.toString()).mul(right.toString());
}

function validateNotional(
  quantity: Decimal,
  price: Decimal,
  rules: Readonly<MarketNotionalRules>,
  exchangeId: string,
  symbol: string,
  kind: MarketKind
): Decimal {
  let notional: Decimal;
  try {
    notional = exactProduct(quantity, price);
  } catch (error) {
    throw failure(
      'QUANTITY_NOT_REPRESENTABLE',
      marketSubject(exchangeId, symbol, kind, 'notional'),
      'exact finite quote notional',
      safeFailureCategory(error)
    );
  }
  if (
    rules.minQuoteNotional !== undefined
    && notional.lt(rules.minQuoteNotional)
  ) {
    throw failure(
      'NOTIONAL_OUT_OF_RANGE',
      marketSubject(exchangeId, symbol, kind, 'notional'),
      `at least ${rules.minQuoteNotional}`,
      notional.toFixed()
    );
  }
  if (
    rules.maxQuoteNotional !== undefined
    && notional.gt(rules.maxQuoteNotional)
  ) {
    throw failure(
      'NOTIONAL_OUT_OF_RANGE',
      marketSubject(exchangeId, symbol, kind, 'notional'),
      `at most ${rules.maxQuoteNotional}`,
      notional.toFixed()
    );
  }
  return notional;
}

async function readBalance(
  gateway: ExchangeGateway,
  exchangeId: string,
  symbol: string,
  kind: MarketKind
): Promise<Decimal> {
  let value: string;
  try {
    value = await gateway.fetchFreeBalance('USDT', kind);
  } catch (error) {
    const known = trustedFailure(error);
    if (known !== undefined) {
      throw known;
    }
    throw failure(
      'BALANCE_UNAVAILABLE',
      accountSubject(exchangeId, symbol, 'balance'),
      'successful non-negative USDT balance read',
      safeFailureCategory(error)
    );
  }
  const parsed = parsedDecimal(value);
  if (parsed === undefined || parsed.lt(0)) {
    throw failure(
      'BALANCE_UNAVAILABLE',
      accountSubject(exchangeId, symbol, 'balance'),
      'finite non-negative USDT balance',
      decimalActual(value)
    );
  }
  return parsed;
}

function assertSufficientBalance(
  availableQuote: Decimal,
  requiredQuote: Decimal,
  exchangeId: string,
  symbol: string
): void {
  if (availableQuote.lt(requiredQuote)) {
    throw failure(
      'BALANCE_INSUFFICIENT',
      accountSubject(exchangeId, symbol, 'balance'),
      `USDT capacity at least ${requiredQuote.toFixed()}`,
      availableQuote.toFixed()
    );
  }
}

function completeMarket(
  identity: Readonly<MarketIdentity>,
  quantityRules: Readonly<MarketQuantityRules>,
  notionalRules: Readonly<MarketNotionalRules>
): Readonly<MarketRules> {
  return Object.freeze({ ...identity, ...quantityRules, ...notionalRules });
}

export class PreflightService {
  constructor(
    private readonly registry: ExchangeRegistry,
    private readonly clock: () => Date = () => new Date()
  ) {}

  async run(
    input: PreflightInput,
    phase: PreflightPhase = 'preflight'
  ): Promise<PreflightResult> {
    try {
      return await this.runOrdered(requestSnapshot(input));
    } catch (error) {
      const known = trustedFailure(error, phase);
      if (known !== undefined) {
        throw known;
      }
      throw createTradeOpsError({
        code: 'REQUEST_OPERATION_FAILED',
        phase,
        subject: { type: 'request', field: 'preflight' },
        expected: 'successful preflight request processing',
        actual: safeFailureCategory(error)
      });
    }
  }

  private async runOrdered(
    request: Readonly<PreflightInput>
  ): Promise<PreflightResult> {
    validateRequest(request);

    const configuredIds = new Set(this.registry.ids());
    const spotGateway = configuredGateway(
      this.registry,
      configuredIds,
      request.spotExchangeId
    );
    const contractGateway = configuredGateway(
      this.registry,
      configuredIds,
      request.contractExchangeId
    );

    const spotSnapshot = await loadSnapshot(
      spotGateway,
      request.spotExchangeId,
      request.symbol,
      'spot'
    );
    validateIdentity(
      spotSnapshot.identity,
      request.spotExchangeId,
      request.symbol,
      'spot'
    );

    const contractSnapshot = await loadSnapshot(
      contractGateway,
      request.contractExchangeId,
      request.symbol,
      'swap'
    );
    validateIdentity(
      contractSnapshot.identity,
      request.contractExchangeId,
      request.symbol,
      'swap'
    );
    validateMarketPair(request, spotSnapshot.identity, contractSnapshot.identity);

    const confirmed = await readAccountSettings(
      contractSnapshot,
      request.contractExchangeId,
      request.symbol
    );

    const spotQuantityRules = readQuantityRules(
      spotSnapshot,
      request.spotExchangeId,
      request.symbol,
      'spot'
    );
    const contractQuantityRules = readQuantityRules(
      contractSnapshot,
      request.contractExchangeId,
      request.symbol,
      'swap'
    );
    const effectiveBaseQuantity = effectiveQuantity(
      request,
      spotQuantityRules,
      contractQuantityRules
    );
    const quantity = decimal(effectiveBaseQuantity);

    const spotReferencePrice = await readPrice(
      spotSnapshot,
      request.spotExchangeId,
      request.symbol,
      'spot'
    );
    const spotNotionalRules = readNotionalRules(
      spotSnapshot,
      request.spotExchangeId,
      request.symbol,
      'spot'
    );
    const spotQuoteNotional = validateNotional(
      quantity,
      spotReferencePrice,
      spotNotionalRules,
      request.spotExchangeId,
      request.symbol,
      'spot'
    );

    const contractReferencePrice = await readPrice(
      contractSnapshot,
      request.contractExchangeId,
      request.symbol,
      'swap'
    );
    const contractNotionalRules = readNotionalRules(
      contractSnapshot,
      request.contractExchangeId,
      request.symbol,
      'swap'
    );
    const contractQuoteNotional = validateNotional(
      quantity,
      contractReferencePrice,
      contractNotionalRules,
      request.contractExchangeId,
      request.symbol,
      'swap'
    );

    const spotFreeUsdt = await readBalance(
      spotGateway,
      request.spotExchangeId,
      request.symbol,
      'spot'
    );
    assertSufficientBalance(
      spotFreeUsdt,
      spotQuoteNotional,
      request.spotExchangeId,
      request.symbol
    );

    const contractFreeUsdt = await readBalance(
      contractGateway,
      request.contractExchangeId,
      request.symbol,
      'swap'
    );
    let leveragedContractBalance: Decimal;
    try {
      leveragedContractBalance = exactProduct(
        contractFreeUsdt,
        confirmed.leverage
      );
    } catch (error) {
      throw failure(
        'BALANCE_UNAVAILABLE',
        accountSubject(request.contractExchangeId, request.symbol, 'balance'),
        'exact leveraged USDT balance',
        safeFailureCategory(error)
      );
    }
    assertSufficientBalance(
      leveragedContractBalance,
      contractQuoteNotional,
      request.contractExchangeId,
      request.symbol
    );

    const spotMarket = completeMarket(
      spotSnapshot.identity,
      spotQuantityRules,
      spotNotionalRules
    );
    const contractMarket = completeMarket(
      contractSnapshot.identity,
      contractQuantityRules,
      contractNotionalRules
    );
    return {
      ...request,
      effectiveBaseQuantity,
      spotMarket: { ...spotMarket },
      contractMarket: { ...contractMarket },
      accountSettings: { ...confirmed.settings },
      spotFreeUsdt: spotFreeUsdt.toFixed(),
      contractFreeUsdt: contractFreeUsdt.toFixed(),
      spotReferencePrice: spotReferencePrice.toFixed(),
      contractReferencePrice: contractReferencePrice.toFixed(),
      riskAcknowledgementRequired: true,
      createdAt: this.clock().toISOString()
    };
  }
}
