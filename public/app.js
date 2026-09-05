const spotExchange = document.querySelector('#spot-exchange');
const contractExchange = document.querySelector('#contract-exchange');
const symbolInput = document.querySelector('#symbol');
const quantityInput = document.querySelector('#base-quantity');
const modeInput = document.querySelector('#mode');
const preflightForm = document.querySelector('#preflight-form');
const preflightButton = document.querySelector('#preflight-button');
const resumeStrategyIdInput = document.querySelector('#resume-strategy-id');
const resumeForm = document.querySelector('#resume-form');
const loadStrategyButton = document.querySelector('#load-strategy-button');
const riskAck = document.querySelector('#risk-ack');
const confirmButton = document.querySelector('#confirm-button');
const refreshButton = document.querySelector('#refresh-button');
const operatorMessage = document.querySelector('#operator-message');
const preflightInputs = [
  spotExchange,
  contractExchange,
  symbolInput,
  quantityInput,
  modeInput
];

let strategyId = null;
let preflightReady = false;
let requestPending = false;
let inputRevision = 0;
let submittedStrategyInput = null;

const executionModes = new Set([
  'CONCURRENT',
  'CONTRACT_FIRST',
  'SPOT_FIRST'
]);
const configuredExchangeIds = new Set(['bitget', 'okx']);
const strategyStates = new Set([
  'PENDING_CONFIRMATION',
  'EXECUTING',
  'WAITING_HEDGE',
  'HEDGED',
  'HEDGE_INCOMPLETE',
  'FAILED'
]);
const orderRoles = new Set([
  'SPOT_MARKET',
  'CONTRACT_MARKET',
  'SPOT_HEDGE_GTC',
  'CONTRACT_HEDGE_GTC'
]);
const strategyFailureCodes = new Set([
  'ORDER_SUBMISSION_FAILED',
  'ORDER_SUBMISSION_UNKNOWN',
  'ORDER_NOT_FOUND',
  'NO_FILL',
  'MISSING_AVERAGE_PRICE',
  'HEDGE_ORDER_REJECTED',
  'HEDGE_ORDER_CANCELED',
  'ORDER_RECONCILIATION_FAILED',
  'INCONSISTENT_ORDER_STATE'
]);
const failureStates = new Set(['HEDGE_INCOMPLETE', 'FAILED']);
const orderStatuses = new Set([
  'planned',
  'open',
  'closed',
  'canceled',
  'rejected',
  'unknown'
]);
const snapshotStatuses = new Set([
  'open',
  'closed',
  'canceled',
  'rejected',
  'unknown'
]);
const resumableStates = new Set([
  'PENDING_CONFIRMATION',
  'EXECUTING'
]);

function setText(id, value) {
  document.querySelector(`#${id}`).textContent = String(value);
}

function setMessage(message, kind = '') {
  operatorMessage.textContent = message;
  operatorMessage.dataset.kind = kind;
}

function resetOrderList(id) {
  const list = document.querySelector(`#${id}`);
  const item = document.createElement('li');
  item.textContent = '暂无';
  list.replaceChildren(item);
}

function updateConfirmButton() {
  confirmButton.disabled = (
    requestPending
    || strategyId === null
    || !preflightReady
    || !riskAck.checked
  );
}

function clearPreview() {
  for (const id of [
    'requested-quantity',
    'effective-quantity',
    'spot-price',
    'contract-price',
    'spot-balance',
    'contract-balance',
    'margin-mode',
    'position-mode',
    'leverage',
    'strategy-id',
    'strategy-state'
  ]) {
    setText(id, '—');
  }
  setText('spot-actual-fill', '0');
  setText('contract-actual-fill', '0');
  setText('unmatched-quantity', '0');
  resetOrderList('spot-order-ids');
  resetOrderList('contract-order-ids');
}

function resetActionablePreview(message, kind = '') {
  strategyId = null;
  preflightReady = false;
  requestPending = false;
  submittedStrategyInput = null;
  riskAck.checked = false;
  preflightButton.disabled = false;
  loadStrategyButton.disabled = false;
  refreshButton.disabled = true;
  updateConfirmButton();
  clearPreview();
  setMessage(message, kind);
}

function invalidatePreflight() {
  inputRevision += 1;
  resetActionablePreview('参数已变更，请重新预检。');
}

for (const input of preflightInputs) {
  input.addEventListener('input', invalidatePreflight);
  input.addEventListener('change', invalidatePreflight);
}

resumeStrategyIdInput.addEventListener('input', () => {
  inputRevision += 1;
  resetActionablePreview('对冲任务 ID 已变更，请重新加载。');
});

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredString(value, maximumLength = 10_000) {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > maximumLength
  ) {
    throw new Error('invalid response string');
  }
  return value;
}

function nonNegativeDecimalString(value, maximumLength = 10_000) {
  const text = requiredString(value, maximumLength);
  if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(text)) {
    throw new Error('invalid non-negative decimal');
  }
  return text;
}

function positiveDecimalString(value, maximumLength = 10_000) {
  const text = nonNegativeDecimalString(value, maximumLength);
  if (!/[1-9]/.test(text)) {
    throw new Error('invalid positive decimal');
  }
  return text;
}

function matchingString(value, expected, maximumLength) {
  const text = requiredString(value, maximumLength);
  if (text !== expected) {
    throw new Error('response identity mismatch');
  }
  return text;
}

function exactObject(value, requiredKeys, optionalKeys = []) {
  if (!isRecord(value)) {
    throw new Error('invalid response object');
  }
  const allowed = new Set([...requiredKeys, ...optionalKeys]);
  const keys = Object.keys(value);
  if (
    requiredKeys.some((key) => !Object.hasOwn(value, key))
    || keys.some((key) => !allowed.has(key))
  ) {
    throw new Error('invalid response fields');
  }
  return value;
}

function canonicalTimestamp(value) {
  const timestamp = requiredString(value, 64);
  try {
    if (new Date(timestamp).toISOString() !== timestamp) {
      throw new Error('invalid response timestamp');
    }
  } catch {
    throw new Error('invalid response timestamp');
  }
  return timestamp;
}

function decimalParts(value, positive = false) {
  const text = positive
    ? positiveDecimalString(value)
    : nonNegativeDecimalString(value);
  const [whole, fraction = ''] = text.split('.');
  return {
    text,
    units: BigInt(`${whole}${fraction}`),
    scale: fraction.length
  };
}

function scaledUnits(value, scale) {
  return value.units * (10n ** BigInt(scale - value.scale));
}

function compareDecimals(leftText, rightText) {
  const left = decimalParts(leftText);
  const right = decimalParts(rightText);
  const scale = Math.max(left.scale, right.scale);
  const leftUnits = scaledUnits(left, scale);
  const rightUnits = scaledUnits(right, scale);
  return leftUnits < rightUnits ? -1 : leftUnits > rightUnits ? 1 : 0;
}

function sumDecimalParts(values) {
  const parsed = values.map((value) => decimalParts(value));
  const scale = parsed.reduce(
    (highest, value) => Math.max(highest, value.scale),
    0
  );
  return {
    units: parsed.reduce(
      (total, value) => total + scaledUnits(value, scale),
      0n
    ),
    scale
  };
}

function decimalPartsEqual(left, right) {
  const scale = Math.max(left.scale, right.scale);
  return scaledUnits(left, scale) === scaledUnits(right, scale);
}

function absoluteDecimalDifference(left, right) {
  const scale = Math.max(left.scale, right.scale);
  const difference = scaledUnits(left, scale) - scaledUnits(right, scale);
  return {
    units: difference < 0n ? -difference : difference,
    scale
  };
}

function validatedMarket(value, expected) {
  const market = exactObject(value, [
    'exchangeId',
    'symbol',
    'marketId',
    'kind',
    'base',
    'quote',
    'active',
    'amountStep',
    'contractSize',
    'minBaseAmount',
    'priceStep'
  ], [
    'maxBaseAmount',
    'minQuoteNotional',
    'maxQuoteNotional'
  ]);
  const result = {
    exchangeId: matchingString(market.exchangeId, expected.exchangeId, 128),
    symbol: matchingString(market.symbol, expected.symbol, 64),
    marketId: requiredString(market.marketId, 256),
    kind: matchingString(market.kind, expected.kind, 16),
    base: matchingString(market.base, expected.base, 64),
    quote: matchingString(market.quote, 'USDT', 16),
    active: market.active,
    amountStep: positiveDecimalString(market.amountStep),
    contractSize: positiveDecimalString(market.contractSize),
    minBaseAmount: nonNegativeDecimalString(market.minBaseAmount),
    priceStep: positiveDecimalString(market.priceStep)
  };
  if (result.active !== true) {
    throw new Error('inactive response market');
  }
  for (const [key, positive] of [
    ['maxBaseAmount', true],
    ['minQuoteNotional', false],
    ['maxQuoteNotional', true]
  ]) {
    if (Object.hasOwn(market, key)) {
      result[key] = positive
        ? positiveDecimalString(market[key])
        : nonNegativeDecimalString(market[key]);
    }
  }
  if (
    result.maxBaseAmount !== undefined
    && compareDecimals(result.minBaseAmount, result.maxBaseAmount) > 0
  ) {
    throw new Error('invalid market amount range');
  }
  if (
    result.minQuoteNotional !== undefined
    && result.maxQuoteNotional !== undefined
    && compareDecimals(
      result.minQuoteNotional,
      result.maxQuoteNotional
    ) > 0
  ) {
    throw new Error('invalid market notional range');
  }
  return result;
}

function validatedIdentity(value, expectedInput) {
  if (!isRecord(value)) {
    throw new Error('invalid response identity');
  }
  const spotExchangeId = matchingString(
    value.spotExchangeId,
    expectedInput.spotExchangeId,
    128
  );
  const contractExchangeId = matchingString(
    value.contractExchangeId,
    expectedInput.contractExchangeId,
    128
  );
  const symbol = matchingString(value.symbol, expectedInput.symbol, 64);
  const requestedBaseQuantity = positiveDecimalString(
    value.requestedBaseQuantity,
    256
  );
  if (requestedBaseQuantity !== expectedInput.requestedBaseQuantity) {
    throw new Error('response quantity mismatch');
  }
  const mode = matchingString(value.mode, expectedInput.mode, 32);
  if (!executionModes.has(mode)) {
    throw new Error('invalid execution mode');
  }
  return {
    spotExchangeId,
    contractExchangeId,
    symbol,
    requestedBaseQuantity,
    mode
  };
}

function validatedPreview(value, expectedInput) {
  const preview = exactObject(value, [
    'spotExchangeId',
    'contractExchangeId',
    'symbol',
    'requestedBaseQuantity',
    'mode',
    'effectiveBaseQuantity',
    'spotMarket',
    'contractMarket',
    'accountSettings',
    'spotFreeUsdt',
    'contractFreeUsdt',
    'spotReferencePrice',
    'contractReferencePrice',
    'riskAcknowledgementRequired',
    'createdAt'
  ]);
  const identity = validatedIdentity(preview, expectedInput);
  const accountSettings = exactObject(preview.accountSettings, [
    'marginMode',
    'positionMode',
    'leverage'
  ]);
  const marginMode = requiredString(accountSettings.marginMode, 32);
  const positionMode = requiredString(accountSettings.positionMode, 32);
  if (!['isolated', 'cross'].includes(marginMode)) {
    throw new Error('invalid margin mode');
  }
  if (positionMode !== 'hedged') {
    throw new Error('hedged position mode is required');
  }
  const leverage = positiveDecimalString(accountSettings.leverage);
  if (preview.riskAcknowledgementRequired !== true) {
    throw new Error('invalid risk acknowledgement requirement');
  }
  const effectiveBaseQuantity = positiveDecimalString(
    preview.effectiveBaseQuantity
  );
  if (
    compareDecimals(
      effectiveBaseQuantity,
      identity.requestedBaseQuantity
    ) > 0
  ) {
    throw new Error('effective quantity exceeds request');
  }
  const base = identity.symbol.split('/')[0];
  if (base === undefined || base.length === 0) {
    throw new Error('invalid market base');
  }
  return {
    ...identity,
    effectiveBaseQuantity,
    spotMarket: validatedMarket(preview.spotMarket, {
      exchangeId: identity.spotExchangeId,
      symbol: identity.symbol,
      kind: 'spot',
      base
    }),
    contractMarket: validatedMarket(preview.contractMarket, {
      exchangeId: identity.contractExchangeId,
      symbol: identity.symbol,
      kind: 'swap',
      base
    }),
    spotReferencePrice: positiveDecimalString(preview.spotReferencePrice),
    contractReferencePrice: positiveDecimalString(
      preview.contractReferencePrice
    ),
    spotFreeUsdt: positiveDecimalString(preview.spotFreeUsdt),
    contractFreeUsdt: positiveDecimalString(preview.contractFreeUsdt),
    riskAcknowledgementRequired: true,
    accountSettings: {
      marginMode,
      positionMode,
      leverage
    },
    createdAt: canonicalTimestamp(preview.createdAt)
  };
}

function validatedPreflightResponse(value, expectedInput) {
  const response = exactObject(value, ['id', 'state', 'preflight']);
  const id = requiredString(response.id, 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id)) {
    throw new Error('invalid strategy id');
  }
  if (response.state !== 'PENDING_CONFIRMATION') {
    throw new Error('invalid preflight state');
  }
  return {
    id,
    state: response.state,
    preflight: validatedPreview(response.preflight, expectedInput)
  };
}

function validatedStrategy(value, expectedInput, expectedStrategyId, preview) {
  const strategy = exactObject(value, [
    'id',
    'state',
    'mode',
    'spotExchangeId',
    'contractExchangeId',
    'symbol',
    'requestedBaseQuantity',
    'effectiveBaseQuantity',
    'failureCode',
    'createdAt',
    'updatedAt'
  ]);
  const id = matchingString(strategy.id, expectedStrategyId, 128);
  const state = requiredString(strategy.state, 32);
  if (!strategyStates.has(state)) {
    throw new Error('invalid strategy state');
  }
  const identity = validatedIdentity(strategy, expectedInput);
  const effectiveBaseQuantity = matchingString(
    strategy.effectiveBaseQuantity,
    preview.effectiveBaseQuantity,
    10_000
  );
  const failureCode = strategy.failureCode;
  if (
    failureStates.has(state)
      ? typeof failureCode !== 'string'
        || !strategyFailureCodes.has(failureCode)
      : failureCode !== null
  ) {
    throw new Error('invalid strategy failure state');
  }
  const createdAt = canonicalTimestamp(strategy.createdAt);
  const updatedAt = canonicalTimestamp(strategy.updatedAt);
  if (new Date(updatedAt).getTime() < new Date(createdAt).getTime()) {
    throw new Error('strategy time regression');
  }
  return {
    id,
    state,
    ...identity,
    effectiveBaseQuantity,
    failureCode,
    createdAt,
    updatedAt
  };
}

function expectedOrderSemantics(role, strategy) {
  switch (role) {
    case 'SPOT_MARKET':
      return {
        exchangeId: strategy.spotExchangeId,
        kind: 'spot',
        type: 'market',
        side: 'buy',
        contract: false,
        hedge: false
      };
    case 'CONTRACT_MARKET':
      return {
        exchangeId: strategy.contractExchangeId,
        kind: 'swap',
        type: 'market',
        side: 'sell',
        contract: true,
        hedge: false
      };
    case 'SPOT_HEDGE_GTC':
      return {
        exchangeId: strategy.spotExchangeId,
        kind: 'spot',
        type: 'limit',
        side: 'buy',
        contract: false,
        hedge: true
      };
    case 'CONTRACT_HEDGE_GTC':
      return {
        exchangeId: strategy.contractExchangeId,
        kind: 'swap',
        type: 'limit',
        side: 'sell',
        contract: true,
        hedge: true
      };
    default:
      throw new Error('invalid order role');
  }
}

async function expectedClientOrderId(strategyId, role) {
  if (
    globalThis.crypto === undefined
    || globalThis.crypto.subtle === undefined
  ) {
    throw new Error('secure digest unavailable');
  }
  const encoded = new TextEncoder().encode(`${strategyId}\0${role}`);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', encoded);
  return [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 32);
}

function validatedOrderRequest(
  value,
  strategy,
  clientOrderId,
  semantics,
  preview
) {
  const requiredKeys = [
    'symbol',
    'kind',
    'type',
    'side',
    'baseQuantity',
    'clientOrderId'
  ];
  if (semantics.hedge) {
    requiredKeys.push('price', 'timeInForce');
  }
  if (semantics.contract) {
    requiredKeys.push('positionSide', 'marginMode');
  }
  const request = exactObject(value, requiredKeys);
  const baseQuantity = positiveDecimalString(request.baseQuantity);
  if (compareDecimals(baseQuantity, strategy.effectiveBaseQuantity) > 0) {
    throw new Error('order quantity exceeds strategy');
  }
  const result = {
    symbol: matchingString(request.symbol, strategy.symbol, 64),
    kind: matchingString(request.kind, semantics.kind, 16),
    type: matchingString(request.type, semantics.type, 16),
    side: matchingString(request.side, semantics.side, 16),
    baseQuantity,
    clientOrderId: matchingString(
      request.clientOrderId,
      clientOrderId,
      32
    )
  };
  if (semantics.hedge) {
    result.price = positiveDecimalString(request.price);
    result.timeInForce = matchingString(
      request.timeInForce,
      'GTC',
      16
    );
  }
  if (semantics.contract) {
    result.positionSide = matchingString(
      request.positionSide,
      'SHORT',
      16
    );
    result.marginMode = matchingString(
      request.marginMode,
      preview.accountSettings.marginMode,
      16
    );
  }
  return result;
}

function validatedOrderSnapshot(
  value,
  order,
  request,
  orderStatus,
  exchangeOrderId
) {
  const snapshot = exactObject(value, [
    'exchangeId',
    'exchangeOrderId',
    'clientOrderId',
    'symbol',
    'kind',
    'type',
    'side',
    'requestedBaseQuantity',
    'filledBaseQuantity',
    'remainingBaseQuantity',
    'averagePrice',
    'status',
    'updatedAt'
  ]);
  const status = requiredString(snapshot.status, 16);
  if (!snapshotStatuses.has(status) || status !== orderStatus) {
    throw new Error('snapshot status mismatch');
  }
  const requestedBaseQuantity = positiveDecimalString(
    snapshot.requestedBaseQuantity
  );
  if (compareDecimals(requestedBaseQuantity, request.baseQuantity) !== 0) {
    throw new Error('snapshot request quantity mismatch');
  }
  const filledBaseQuantity = nonNegativeDecimalString(
    snapshot.filledBaseQuantity
  );
  const remainingBaseQuantity = nonNegativeDecimalString(
    snapshot.remainingBaseQuantity
  );
  if (
    !decimalPartsEqual(
      sumDecimalParts([filledBaseQuantity, remainingBaseQuantity]),
      decimalParts(requestedBaseQuantity)
    )
  ) {
    throw new Error('snapshot quantity mismatch');
  }
  const averagePrice = snapshot.averagePrice === null
    ? null
    : positiveDecimalString(snapshot.averagePrice);
  return {
    exchangeId: matchingString(
      snapshot.exchangeId,
      order.exchangeId,
      128
    ),
    exchangeOrderId: matchingString(
      snapshot.exchangeOrderId,
      exchangeOrderId,
      256
    ),
    clientOrderId: matchingString(
      snapshot.clientOrderId,
      order.clientOrderId,
      32
    ),
    symbol: matchingString(snapshot.symbol, request.symbol, 64),
    kind: matchingString(snapshot.kind, request.kind, 16),
    type: matchingString(snapshot.type, request.type, 16),
    side: matchingString(snapshot.side, request.side, 16),
    requestedBaseQuantity,
    filledBaseQuantity,
    remainingBaseQuantity,
    averagePrice,
    status,
    updatedAt: canonicalTimestamp(snapshot.updatedAt)
  };
}

async function validatedOrder(value, strategy, preview) {
  const order = exactObject(value, [
    'id',
    'strategyId',
    'role',
    'exchangeId',
    'clientOrderId',
    'exchangeOrderId',
    'request',
    'snapshot',
    'status',
    'createdAt',
    'updatedAt'
  ]);
  const id = requiredString(order.id, 36);
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
      .test(id)
  ) {
    throw new Error('invalid strategy order id');
  }
  matchingString(order.strategyId, strategy.id, 128);
  const role = requiredString(order.role, 32);
  if (!orderRoles.has(role)) {
    throw new Error('invalid order role');
  }
  const semantics = expectedOrderSemantics(role, strategy);
  const exchangeId = matchingString(
    order.exchangeId,
    semantics.exchangeId,
    128
  );
  const clientOrderId = requiredString(order.clientOrderId, 32);
  if (
    !/^[0-9a-f]{32}$/.test(clientOrderId)
    || clientOrderId !== await expectedClientOrderId(strategy.id, role)
  ) {
    throw new Error('invalid client order id');
  }
  const request = validatedOrderRequest(
    order.request,
    strategy,
    clientOrderId,
    semantics,
    preview
  );
  const status = requiredString(order.status, 16);
  if (!orderStatuses.has(status)) {
    throw new Error('invalid order status');
  }
  const createdAt = canonicalTimestamp(order.createdAt);
  const updatedAt = canonicalTimestamp(order.updatedAt);
  if (new Date(updatedAt).getTime() < new Date(createdAt).getTime()) {
    throw new Error('order time regression');
  }
  let exchangeOrderId = null;
  let snapshot = null;
  if (status === 'planned') {
    if (order.exchangeOrderId !== null || order.snapshot !== null) {
      throw new Error('planned order has exchange state');
    }
  } else {
    exchangeOrderId = requiredString(order.exchangeOrderId, 256);
    snapshot = validatedOrderSnapshot(
      order.snapshot,
      {
        exchangeId,
        clientOrderId
      },
      request,
      status,
      exchangeOrderId
    );
  }
  return {
    id,
    strategyId: strategy.id,
    role,
    exchangeId,
    clientOrderId,
    exchangeOrderId,
    request,
    snapshot,
    status,
    createdAt,
    updatedAt
  };
}

function orderTopologyMatchesStrategy(strategy, orders) {
  const roles = new Set(orders.map((order) => order.role));
  if (strategy.state === 'PENDING_CONFIRMATION') {
    return roles.size === 0;
  }

  const diagnosticState = failureStates.has(strategy.state);
  if (strategy.mode !== 'CONCURRENT') {
    const [firstRole, secondRole] = strategy.mode === 'CONTRACT_FIRST'
      ? ['CONTRACT_MARKET', 'SPOT_HEDGE_GTC']
      : ['SPOT_MARKET', 'CONTRACT_HEDGE_GTC'];
    if ([...roles].some((role) => (
      role !== firstRole && role !== secondRole
    ))) {
      return false;
    }
    if (diagnosticState) {
      return true;
    }
    if (strategy.state === 'EXECUTING') {
      return !roles.has(secondRole) || roles.has(firstRole);
    }
    return roles.size === 2;
  }

  const hasBothMarkets = (
    roles.has('SPOT_MARKET')
    && roles.has('CONTRACT_MARKET')
  );
  const hedgeCount = [
    'SPOT_HEDGE_GTC',
    'CONTRACT_HEDGE_GTC'
  ].filter((role) => roles.has(role)).length;
  if (hedgeCount > 1) {
    return false;
  }
  if (diagnosticState) {
    return true;
  }
  if (strategy.state === 'EXECUTING') {
    return (
      hasBothMarkets
      || (
        hedgeCount === 0
        && [...roles].every((role) => (
          role === 'SPOT_MARKET' || role === 'CONTRACT_MARKET'
        ))
      )
    );
  }
  if (strategy.state === 'WAITING_HEDGE') {
    return hasBothMarkets && hedgeCount === 1;
  }
  return hasBothMarkets;
}

function validatedActualFills(value, orders) {
  const fills = exactObject(value, [
    'spotBuyBaseQuantity',
    'contractShortBaseQuantity',
    'unmatchedBaseQuantity'
  ]);
  const result = {
    spotBuyBaseQuantity: nonNegativeDecimalString(
      fills.spotBuyBaseQuantity
    ),
    contractShortBaseQuantity: nonNegativeDecimalString(
      fills.contractShortBaseQuantity
    ),
    unmatchedBaseQuantity: nonNegativeDecimalString(
      fills.unmatchedBaseQuantity
    )
  };
  const spot = sumDecimalParts(orders
    .filter((order) => (
      order.snapshot !== null
      && order.snapshot.kind === 'spot'
      && order.snapshot.side === 'buy'
    ))
    .map((order) => order.snapshot.filledBaseQuantity));
  const contract = sumDecimalParts(orders
    .filter((order) => (
      order.snapshot !== null
      && order.snapshot.kind === 'swap'
      && order.snapshot.side === 'sell'
      && order.request.positionSide === 'SHORT'
    ))
    .map((order) => order.snapshot.filledBaseQuantity));
  if (
    !decimalPartsEqual(spot, decimalParts(result.spotBuyBaseQuantity))
    || !decimalPartsEqual(
      contract,
      decimalParts(result.contractShortBaseQuantity)
    )
    || !decimalPartsEqual(
      absoluteDecimalDifference(spot, contract),
      decimalParts(result.unmatchedBaseQuantity)
    )
  ) {
    throw new Error('actual fill totals mismatch');
  }
  return result;
}

function orderForRole(orders, role) {
  return orders.find((order) => order.role === role);
}

function isTrustedSequentialFirst(order) {
  const snapshot = order?.snapshot;
  return (
    snapshot !== null
    && snapshot !== undefined
    && compareDecimals(snapshot.filledBaseQuantity, '0') > 0
    && snapshot.averagePrice !== null
    && (snapshot.status === 'closed' || snapshot.status === 'canceled')
  );
}

function isReliableTerminalConcurrentMarket(order) {
  const snapshot = order?.snapshot;
  return (
    snapshot !== null
    && snapshot !== undefined
    && (snapshot.status === 'closed' || snapshot.status === 'canceled')
  );
}

function isPendingHedge(order) {
  return (
    order.snapshot === null
    || order.snapshot.status === 'open'
    || order.snapshot.status === 'unknown'
  );
}

function isFullClosedHedge(order) {
  const snapshot = order.snapshot;
  return (
    snapshot !== null
    && snapshot.status === 'closed'
    && compareDecimals(
      snapshot.filledBaseQuantity,
      order.request.baseQuantity
    ) === 0
    && compareDecimals(snapshot.remainingBaseQuantity, '0') === 0
  );
}

function orderExecutionMatchesStrategy(strategy, orders, actualFills) {
  if (
    strategy.state === 'PENDING_CONFIRMATION'
    || failureStates.has(strategy.state)
  ) {
    return true;
  }

  const hedge = orders.find((order) => order.role.endsWith('_HEDGE_GTC'));
  if (
    strategy.state === 'WAITING_HEDGE'
    && (hedge === undefined || !isPendingHedge(hedge))
  ) {
    return false;
  }
  if (
    strategy.state === 'HEDGED'
    && (
      compareDecimals(actualFills.spotBuyBaseQuantity, '0') <= 0
      || compareDecimals(actualFills.contractShortBaseQuantity, '0') <= 0
      || compareDecimals(
        actualFills.spotBuyBaseQuantity,
        actualFills.contractShortBaseQuantity
      ) !== 0
      || (hedge !== undefined && !isFullClosedHedge(hedge))
    )
  ) {
    return false;
  }

  if (strategy.mode !== 'CONCURRENT') {
    if (hedge === undefined) {
      return true;
    }
    const firstRole = strategy.mode === 'CONTRACT_FIRST'
      ? 'CONTRACT_MARKET'
      : 'SPOT_MARKET';
    const first = orderForRole(orders, firstRole);
    return (
      isTrustedSequentialFirst(first)
      && compareDecimals(
        hedge.request.baseQuantity,
        first.snapshot.filledBaseQuantity
      ) === 0
    );
  }

  const spot = orderForRole(orders, 'SPOT_MARKET');
  const contract = orderForRole(orders, 'CONTRACT_MARKET');
  if (hedge === undefined) {
    return (
      strategy.state !== 'HEDGED'
      || (
        isReliableTerminalConcurrentMarket(spot)
        && isReliableTerminalConcurrentMarket(contract)
        && compareDecimals(
          spot.snapshot.filledBaseQuantity,
          contract.snapshot.filledBaseQuantity
        ) === 0
      )
    );
  }
  if (
    !isReliableTerminalConcurrentMarket(spot)
    || !isReliableTerminalConcurrentMarket(contract)
  ) {
    return false;
  }
  const fillComparison = compareDecimals(
    spot.snapshot.filledBaseQuantity,
    contract.snapshot.filledBaseQuantity
  );
  if (fillComparison === 0) {
    return false;
  }
  const expectedRole = fillComparison > 0
    ? 'CONTRACT_HEDGE_GTC'
    : 'SPOT_HEDGE_GTC';
  const largerMarket = fillComparison > 0 ? spot : contract;
  return (
    hedge.role === expectedRole
    && largerMarket.snapshot.averagePrice !== null
    && decimalPartsEqual(
      absoluteDecimalDifference(
        decimalParts(spot.snapshot.filledBaseQuantity),
        decimalParts(contract.snapshot.filledBaseQuantity)
      ),
      decimalParts(hedge.request.baseQuantity)
    )
  );
}

async function validatedStatusResponse(
  value,
  expectedInput,
  expectedStrategyId
) {
  const response = exactObject(value, [
    'strategy',
    'preflight',
    'orders',
    'actualFills'
  ]);
  if (
    !Array.isArray(response.orders)
    || response.orders.length > orderRoles.size
  ) {
    throw new Error('invalid status orders');
  }
  const preview = validatedPreview(response.preflight, expectedInput);
  const strategy = validatedStrategy(
    response.strategy,
    expectedInput,
    expectedStrategyId,
    preview
  );
  const orders = await Promise.all(
    response.orders.map((order) => validatedOrder(order, strategy, preview))
  );
  const roleSet = new Set(orders.map((order) => order.role));
  const clientIdSet = new Set(orders.map((order) => order.clientOrderId));
  const orderIdSet = new Set(orders.map((order) => order.id));
  if (
    roleSet.size !== orders.length
    || clientIdSet.size !== orders.length
    || orderIdSet.size !== orders.length
  ) {
    throw new Error('duplicate strategy order identity');
  }
  if (!orderTopologyMatchesStrategy(strategy, orders)) {
    throw new Error('strategy order topology mismatch');
  }
  const actualFills = validatedActualFills(response.actualFills, orders);
  if (!orderExecutionMatchesStrategy(strategy, orders, actualFills)) {
    throw new Error('strategy order execution mismatch');
  }
  return {
    strategy,
    preflight: preview,
    orders,
    actualFills
  };
}

function canonicalStrategyId(value) {
  const id = requiredString(value, 36);
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
      .test(id)
  ) {
    throw new Error('invalid strategy id');
  }
  return id;
}

function validatedLoadedInput(value) {
  if (!isRecord(value)) {
    throw new Error('invalid loaded preflight identity');
  }
  const spotExchangeId = requiredString(value.spotExchangeId, 128);
  const contractExchangeId = requiredString(
    value.contractExchangeId,
    128
  );
  if (
    !configuredExchangeIds.has(spotExchangeId)
    || !configuredExchangeIds.has(contractExchangeId)
    || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(spotExchangeId)
    || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(contractExchangeId)
    || spotExchangeId === contractExchangeId
  ) {
    throw new Error('invalid loaded exchange identity');
  }
  const symbol = requiredString(value.symbol, 64);
  if (!/^[A-Z0-9][A-Z0-9._-]{0,30}\/USDT$/.test(symbol)) {
    throw new Error('invalid loaded symbol');
  }
  const requestedBaseQuantity = positiveDecimalString(
    value.requestedBaseQuantity,
    256
  );
  const mode = requiredString(value.mode, 32);
  if (!executionModes.has(mode)) {
    throw new Error('invalid loaded execution mode');
  }
  return Object.freeze({
    spotExchangeId,
    contractExchangeId,
    symbol,
    requestedBaseQuantity,
    mode
  });
}

async function validatedLoadedStatusResponse(value, expectedStrategyId) {
  if (!isRecord(value)) {
    throw new Error('invalid loaded status response');
  }
  const submittedInput = validatedLoadedInput(value.preflight);
  return {
    submittedInput,
    status: await validatedStatusResponse(
      value,
      submittedInput,
      expectedStrategyId
    )
  };
}

function renderPreflight(strategy) {
  const preview = strategy.preflight;
  setText('strategy-id', strategy.id);
  setText('requested-quantity', preview.requestedBaseQuantity);
  setText('effective-quantity', preview.effectiveBaseQuantity);
  setText('spot-price', preview.spotReferencePrice);
  setText('contract-price', preview.contractReferencePrice);
  setText('spot-balance', preview.spotFreeUsdt);
  setText('contract-balance', preview.contractFreeUsdt);
  setText('margin-mode', preview.accountSettings.marginMode);
  setText('position-mode', preview.accountSettings.positionMode);
  setText('leverage', preview.accountSettings.leverage);
  setText('strategy-state', strategy.state);
}

function renderOrderIds(id, orders) {
  const list = document.querySelector(`#${id}`);
  const items = orders.map((order) => {
    const item = document.createElement('li');
    const exchangeOrderId = order.exchangeOrderId ?? '待交易所分配';
    item.textContent = `${exchangeOrderId}（client: ${order.clientOrderId}）`;
    return item;
  });
  if (items.length === 0) {
    const item = document.createElement('li');
    item.textContent = '暂无';
    items.push(item);
  }
  list.replaceChildren(...items);
}

function renderStatus(status) {
  renderPreflight({
    id: status.strategy.id,
    preflight: status.preflight,
    state: status.strategy.state
  });
  const spotOrders = status.orders.filter(
    (order) => order.role.startsWith('SPOT_')
  );
  const contractOrders = status.orders.filter(
    (order) => order.role.startsWith('CONTRACT_')
  );
  renderOrderIds('spot-order-ids', spotOrders);
  renderOrderIds('contract-order-ids', contractOrders);
  setText('spot-actual-fill', status.actualFills.spotBuyBaseQuantity);
  setText(
    'contract-actual-fill',
    status.actualFills.contractShortBaseQuantity
  );
  setText('unmatched-quantity', status.actualFills.unmatchedBaseQuantity);
}

async function responseJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

const operatorErrorTextLimit = 2000;
const operatorTruncationSuffix = '…[truncated]';

class OperatorRequestError extends Error {
  constructor(operatorMessage) {
    super(operatorMessage);
    this.operatorMessage = operatorMessage;
  }
}

function boundedOperatorText(value) {
  if (typeof value !== 'string' || value.length === 0) {
    return null;
  }
  return value.length <= operatorErrorTextLimit
    ? value
    : `${value.slice(
        0,
        operatorErrorTextLimit - operatorTruncationSuffix.length
      )}${operatorTruncationSuffix}`;
}

function caughtOperatorText(error, fallback) {
  const message = boundedOperatorText(error?.message);
  if (message !== null) {
    return message;
  }
  try {
    return boundedOperatorText(String(error)) ?? fallback;
  } catch {
    return fallback;
  }
}

function serverFailureMessage(operation, response, body) {
  const lines = [`${operation}失败`];
  const code = isRecord(body) ? boundedOperatorText(body.code) : null;
  lines.push(`HTTP ${response.status}${code === null ? '' : ` · ${code}`}`);
  const detail = isRecord(body?.error) ? body.error : null;
  const detailType = boundedOperatorText(detail?.type);
  const detailMessage = boundedOperatorText(detail?.message);
  const detailCode = typeof detail?.code === 'number'
    && Number.isFinite(detail.code)
    ? String(detail.code)
    : boundedOperatorText(detail?.code);
  if (detailType !== null && detailMessage !== null) {
    lines.push(
      `${detailType}${detailCode === null ? '' : ` [${detailCode}]`}: ${detailMessage}`
    );
  } else {
    const message = isRecord(body) ? boundedOperatorText(body.message) : null;
    lines.push(message ?? '响应不是有效的结构化 JSON 错误');
  }
  const requestId = isRecord(body)
    ? boundedOperatorText(body.requestId)
    : null;
  if (requestId !== null) {
    lines.push(`请求 ID：${requestId}`);
  }
  return lines.join('\n');
}

async function requestJson(operation, url, options, expectedStatus) {
  let response;
  try {
    response = await fetch(url, options);
  } catch (error) {
    throw new OperatorRequestError(
      `${operation}失败\n网络错误：${caughtOperatorText(error, '未知网络错误')}`
    );
  }
  const body = await responseJson(response);
  if (response.status !== expectedStatus) {
    throw new OperatorRequestError(
      serverFailureMessage(operation, response, body)
    );
  }
  if (body === null) {
    throw new OperatorRequestError(
      `${operation}失败\nHTTP ${response.status}\n响应不是有效 JSON`
    );
  }
  return body;
}

function operatorFailureMessage(operation, error) {
  if (error instanceof OperatorRequestError) {
    return error.operatorMessage;
  }
  return `${operation}失败\n响应校验失败：${caughtOperatorText(
    error,
    '未知响应错误'
  )}`;
}

async function refreshStatus() {
  if (
    strategyId === null
    || submittedStrategyInput === null
    || requestPending
  ) {
    return;
  }
  const statusRevision = inputRevision;
  const statusStrategyId = strategyId;
  const statusExpectedInput = submittedStrategyInput;
  requestPending = true;
  refreshButton.disabled = true;
  loadStrategyButton.disabled = true;
  updateConfirmButton();
  try {
    const body = await requestJson(
      '状态刷新',
      `/api/hedges/${encodeURIComponent(statusStrategyId)}`,
      { headers: { accept: 'application/json' } },
      200
    );
    const status = await validatedStatusResponse(
      body,
      statusExpectedInput,
      statusStrategyId
    );
    if (
      statusRevision !== inputRevision
      || statusStrategyId !== strategyId
    ) {
      return;
    }
    preflightReady = resumableStates.has(status.strategy.state);
    if (!preflightReady) {
      riskAck.checked = false;
    }
    renderStatus(status);
    setMessage('状态已刷新。', 'success');
  } catch (error) {
    if (
      statusRevision === inputRevision
      && statusStrategyId === strategyId
    ) {
      resetActionablePreview(
        operatorFailureMessage('状态刷新', error),
        'error'
      );
    }
  } finally {
    if (
      statusRevision === inputRevision
      && statusStrategyId === strategyId
    ) {
      requestPending = false;
      refreshButton.disabled = false;
      loadStrategyButton.disabled = false;
      updateConfirmButton();
    }
  }
}

resumeForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  inputRevision += 1;
  const loadRevision = inputRevision;
  resetActionablePreview('正在加载已有对冲任务。');
  let requestedStrategyId;
  try {
    if (!resumeForm.reportValidity()) {
      throw new Error('invalid strategy id');
    }
    requestedStrategyId = canonicalStrategyId(
      resumeStrategyIdInput.value
    );
  } catch {
    resetActionablePreview('对冲任务 ID 格式无效。', 'error');
    return;
  }

  requestPending = true;
  preflightButton.disabled = true;
  loadStrategyButton.disabled = true;
  updateConfirmButton();
  try {
    const body = await requestJson(
      '任务加载',
      `/api/hedges/${encodeURIComponent(requestedStrategyId)}`,
      undefined,
      200
    );
    const loaded = await validatedLoadedStatusResponse(
      body,
      requestedStrategyId
    );
    if (
      loadRevision !== inputRevision
      || requestedStrategyId !== resumeStrategyIdInput.value
    ) {
      return;
    }
    const submittedInput = loaded.submittedInput;
    spotExchange.value = submittedInput.spotExchangeId;
    contractExchange.value = submittedInput.contractExchangeId;
    symbolInput.value = submittedInput.symbol;
    quantityInput.value = submittedInput.requestedBaseQuantity;
    modeInput.value = submittedInput.mode;
    submittedStrategyInput = submittedInput;
    strategyId = requestedStrategyId;
    preflightReady = resumableStates.has(loaded.status.strategy.state);
    riskAck.checked = false;
    renderStatus(loaded.status);
    refreshButton.disabled = false;
    setMessage(
      preflightReady
        ? '对冲任务已加载。请核对状态并重新确认风险。'
        : '对冲任务已加载，仅供查看。',
      'success'
    );
  } catch (error) {
    if (loadRevision === inputRevision) {
      resetActionablePreview(
        operatorFailureMessage('任务加载', error),
        'error'
      );
    }
  } finally {
    if (loadRevision === inputRevision) {
      requestPending = false;
      preflightButton.disabled = false;
      loadStrategyButton.disabled = false;
      updateConfirmButton();
    }
  }
});

preflightForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  invalidatePreflight();
  if (!preflightForm.reportValidity()) {
    setMessage('请完整填写合法的开仓参数。', 'error');
    return;
  }
  const submittedRevision = inputRevision;
  const submittedInput = Object.freeze({
    spotExchangeId: spotExchange.value,
    contractExchangeId: contractExchange.value,
    symbol: symbolInput.value,
    requestedBaseQuantity: quantityInput.value,
    mode: modeInput.value
  });
  requestPending = true;
  preflightButton.disabled = true;
  loadStrategyButton.disabled = true;
  updateConfirmButton();
  setMessage('正在预检，请稍候。');
  try {
    const body = await requestJson(
      '预检',
      '/api/hedges/preflight',
      {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json'
        },
        body: JSON.stringify(submittedInput)
      },
      201
    );
    const preflight = validatedPreflightResponse(body, submittedInput);
    if (submittedRevision !== inputRevision) {
      return;
    }
    renderPreflight(preflight);
    submittedStrategyInput = submittedInput;
    strategyId = preflight.id;
    preflightReady = true;
    refreshButton.disabled = false;
    setMessage('预检完成。请核对快照并确认风险。', 'success');
  } catch (error) {
    if (submittedRevision === inputRevision) {
      resetActionablePreview(
        operatorFailureMessage('预检', error),
        'error'
      );
    }
  } finally {
    if (submittedRevision === inputRevision) {
      requestPending = false;
      preflightButton.disabled = false;
      loadStrategyButton.disabled = false;
      updateConfirmButton();
    }
  }
});

riskAck.addEventListener('change', updateConfirmButton);

confirmButton.addEventListener('click', async () => {
  if (
    strategyId === null
    || !preflightReady
    || !riskAck.checked
    || requestPending
  ) {
    return;
  }
  const confirmationRevision = inputRevision;
  const confirmedStrategyId = strategyId;
  requestPending = true;
  preflightReady = false;
  preflightButton.disabled = true;
  loadStrategyButton.disabled = true;
  updateConfirmButton();
  setMessage('正在提交确认。');
  try {
    await requestJson(
      '确认',
      `/api/hedges/${encodeURIComponent(confirmedStrategyId)}/confirm`,
      {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json'
        },
        body: JSON.stringify({ riskAcknowledged: true })
      },
      202
    );
    if (
      confirmationRevision !== inputRevision
      || confirmedStrategyId !== strategyId
    ) {
      return;
    }
    riskAck.checked = false;
    setMessage('确认已受理，正在后台执行', 'success');
  } catch (error) {
    if (
      confirmationRevision === inputRevision
      && confirmedStrategyId === strategyId
    ) {
      preflightReady = true;
      setMessage(operatorFailureMessage('确认', error), 'error');
    }
  } finally {
    if (
      confirmationRevision === inputRevision
      && confirmedStrategyId === strategyId
    ) {
      requestPending = false;
      preflightButton.disabled = false;
      loadStrategyButton.disabled = false;
      refreshButton.disabled = false;
      updateConfirmButton();
    }
  }
});

refreshButton.addEventListener('click', refreshStatus);

async function loadExchanges() {
  try {
    const body = await requestJson(
      '交易所列表加载',
      '/api/exchanges',
      { headers: { accept: 'application/json' } },
      200
    );
    if (!Array.isArray(body?.exchanges)) {
      throw new Error('exchange list unavailable');
    }
    for (const exchangeId of body.exchanges) {
      for (const select of [spotExchange, contractExchange]) {
        const option = document.createElement('option');
        option.value = exchangeId;
        option.textContent = exchangeId;
        select.append(option);
      }
    }
  } catch (error) {
    setMessage(operatorFailureMessage('交易所列表加载', error), 'error');
  }
}

clearPreview();
updateConfirmButton();
void loadExchanges();
