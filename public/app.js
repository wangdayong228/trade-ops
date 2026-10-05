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
let displayedStrategyState = null;

const executionModes = new Set([
  'CONCURRENT',
  'CONTRACT_FIRST',
  'SPOT_FIRST'
]);
const configuredExchangeIds = new Set(['bitget', 'okx']);
const strategyStates = new Set([
  'PENDING_CONFIRMATION',
  'PREFLIGHT_INVALIDATED',
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
  'PENDING_CONFIRMATION'
]);
const errorCodes = new Set([
  'CONFIG_FIELD_MISSING',
  'CONFIG_FIELD_INVALID',
  'DATABASE_OPEN_FAILED',
  'DATABASE_SCHEMA_VERSION_MISMATCH',
  'DATABASE_OWNERSHIP_BUSY',
  'DATABASE_OWNERSHIP_UNAVAILABLE',
  'SERVICE_COMPONENT_FAILED',
  'SERVICE_LISTEN_FAILED',
  'REQUEST_FORBIDDEN',
  'REQUEST_BODY_INVALID',
  'REQUEST_FIELD_INVALID',
  'REQUEST_OPERATION_FAILED',
  'REQUEST_ROUTE_NOT_FOUND',
  'STRATEGY_NOT_FOUND',
  'STRATEGY_STATE_MISMATCH',
  'STRATEGY_OPERATION_BUSY',
  'EXCHANGE_NOT_CONFIGURED',
  'MARKET_UNAVAILABLE',
  'MARKET_IDENTITY_MISMATCH',
  'MARKET_INACTIVE',
  'MARKET_RULE_INVALID',
  'ACCOUNT_SETTINGS_UNAVAILABLE',
  'ACCOUNT_SETTINGS_CONFLICT',
  'ACCOUNT_POSITION_MODE_MISMATCH',
  'ACCOUNT_MARGIN_MODE_MISMATCH',
  'ACCOUNT_LEVERAGE_MISMATCH',
  'QUANTITY_INVALID',
  'QUANTITY_NOT_REPRESENTABLE',
  'QUANTITY_OUT_OF_RANGE',
  'PRICE_UNAVAILABLE',
  'PRICE_INVALID',
  'NOTIONAL_OUT_OF_RANGE',
  'BALANCE_UNAVAILABLE',
  'BALANCE_INSUFFICIENT',
  'PREFLIGHT_INVALIDATED',
  'STORAGE_OPERATION_FAILED',
  'STORAGE_RECORD_INVALID',
  'STORAGE_TRANSITION_REJECTED'
]);
const errorPhases = new Set([
  'startup',
  'request',
  'preflight',
  'confirmation',
  'storage'
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
  if (displayedStrategyState === 'PREFLIGHT_INVALIDATED') {
    riskAck.checked = false;
  }
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
  displayedStrategyState = null;
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

function observedResponseValue(value) {
  if (value === null) return 'null';
  if (typeof value === 'string') return `字符串（长度 ${value.length}）`;
  if (Array.isArray(value)) return `数组（长度 ${value.length}）`;
  return typeof value;
}

function validationFailure(field, expected, actual) {
  return new Error(`${field}检查失败：期望${expected}，实际${actual}`);
}

function requiredString(value, maximumLength = 10_000, field = '响应字符串') {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > maximumLength
  ) {
    throw validationFailure(
      field,
      maximumLength === Infinity
        ? '非空字符串'
        : `长度为 1-${maximumLength} 的字符串`,
      observedResponseValue(value)
    );
  }
  return value;
}

function nonNegativeDecimalString(value, maximumLength = 10_000, field = '响应数量', positive = false) {
  const requirement = positive ? '规范正数十进制字符串（> 0）' : '规范非负十进制字符串';
  if (typeof value !== 'string' || value.length === 0 || value.length > maximumLength) {
    throw validationFailure(field, `${requirement}，长度 1-${maximumLength}`, observedResponseValue(value));
  }
  const text = value;
  if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(text)) {
    throw validationFailure(field, requirement, observedResponseValue(text));
  }
  return text;
}

function positiveDecimalString(value, maximumLength = 10_000, field = '响应数量') {
  const text = nonNegativeDecimalString(value, maximumLength, field, true);
  if (!/[1-9]/.test(text)) {
    throw validationFailure(field, '正数 > 0', '零 0');
  }
  return text;
}

function matchingString(value, expected, maximumLength, field = '响应字段') {
  const text = requiredString(value, maximumLength, field);
  if (text !== expected) {
    throw validationFailure(
      field,
      `字符串 ${JSON.stringify(expected)}`,
      `字符串 ${JSON.stringify(text)}`
    );
  }
  return text;
}

function exactObject(
  value,
  requiredKeys,
  optionalKeys = [],
  field = '响应对象'
) {
  if (!isRecord(value)) {
    throw validationFailure(field, 'JSON 对象', observedResponseValue(value));
  }
  const allowed = new Set([...requiredKeys, ...optionalKeys]);
  const keys = Object.keys(value);
  const missing = requiredKeys.filter((key) => !Object.hasOwn(value, key));
  if (missing.length > 0) {
    throw new Error(
      `${missing.map((key) => `${field}.${key}`).join(', ')}检查失败：期望必填字段，实际缺失`
    );
  }
  const unexpected = keys.filter((key) => !allowed.has(key));
  if (unexpected.length > 0) {
    throw new Error(
      `${field}字段检查失败：不允许字段 ${unexpected.join(', ')}`
    );
  }
  return value;
}

function canonicalTimestamp(value, field = '时间戳') {
  const timestamp = requiredString(value, 64, field);
  try {
    if (new Date(timestamp).toISOString() !== timestamp) {
      throw validationFailure(field, '规范 UTC ISO 8601 时间', timestamp);
    }
  } catch {
    throw validationFailure(field, '规范 UTC ISO 8601 时间', timestamp);
  }
  return timestamp;
}

function optionalSubjectString(value, maximumLength = 128, field = 'error.subject') {
  return value === undefined ? undefined : requiredString(value, maximumLength, field);
}

function validatedErrorSubject(value) {
  if (!isRecord(value)) {
    throw validationFailure('error.subject', 'JSON 对象', observedResponseValue(value));
  }
  switch (value.type) {
    case 'configuration':
    case 'request': {
      const subject = exactObject(value, ['type', 'field']);
      return {
        type: subject.type,
        field: requiredString(subject.field, 128, 'error.subject.field')
      };
    }
    case 'exchange': {
      const subject = exactObject(value, [
        'type', 'exchangeId', 'operation'
      ]);
      return {
        type: subject.type,
        exchangeId: requiredString(subject.exchangeId, 128, 'error.subject.exchangeId'),
        operation: requiredString(subject.operation, 128, 'error.subject.operation')
      };
    }
    case 'market': {
      const subject = exactObject(
        value,
        ['type', 'exchangeId', 'symbol', 'kind'],
        ['field']
      );
      return {
        type: subject.type,
        exchangeId: requiredString(subject.exchangeId, 128, 'error.subject.exchangeId'),
        symbol: requiredString(subject.symbol, 64, 'error.subject.symbol'),
        kind: requiredString(subject.kind, 128, 'error.subject.kind'),
        ...(subject.field === undefined
          ? {}
          : { field: requiredString(subject.field, 128, 'error.subject.field') })
      };
    }
    case 'account': {
      const subject = exactObject(value, [
        'type', 'exchangeId', 'symbol', 'field'
      ]);
      return {
        type: subject.type,
        exchangeId: requiredString(subject.exchangeId, 128, 'error.subject.exchangeId'),
        symbol: requiredString(subject.symbol, 64, 'error.subject.symbol'),
        field: requiredString(subject.field, 128, 'error.subject.field')
      };
    }
    case 'strategy': {
      const subject = exactObject(
        value,
        ['type', 'strategyId'],
        ['field']
      );
      return {
        type: subject.type,
        strategyId: requiredString(subject.strategyId, 128, 'error.subject.strategyId'),
        ...(subject.field === undefined
          ? {}
          : { field: requiredString(subject.field, 128, 'error.subject.field') })
      };
    }
    case 'database': {
      const subject = exactObject(value, ['type'], [
        'path', 'table', 'recordId', 'field', 'operation'
      ]);
      const result = { type: subject.type };
      for (const [key, maximumLength] of [
        ['path', 512],
        ['table', 128],
        ['recordId', 128],
        ['field', 128],
        ['operation', 128]
      ]) {
        const field = optionalSubjectString(subject[key], maximumLength, `error.subject.${key}`);
        if (field !== undefined) result[key] = field;
      }
      return result;
    }
    default:
      throw validationFailure('error.subject.type', 'configuration/request/exchange/market/account/strategy/database', observedResponseValue(value.type));
  }
}

function validatedDiagnosticValue(value, field) {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw validationFailure(field, '有限数字', String(value));
    return value;
  }
  if (typeof value === 'string') {
    if (value.length > 2000) throw validationFailure(field, '长度最多 2000 的字符串', observedResponseValue(value));
    return value;
  }
  if (!Array.isArray(value)) throw validationFailure(field, '安全标量或字符串数组', observedResponseValue(value));
  if (value.length > 16) throw validationFailure(field, '最多 16 项的字符串数组', observedResponseValue(value));
  for (let index = 0; index < value.length; index += 1) {
    if (typeof value[index] !== 'string' || value[index].length > 2000) {
      throw validationFailure(`${field}[${index}]`, '长度最多 2000 的字符串', observedResponseValue(value[index]));
    }
  }
  return [...value];
}

function validatedErrorDetail(value, field = 'error') {
  const detail = exactObject(value, [
    'code',
    'phase',
    'subject',
    'expected',
    'actual',
    'message',
    'occurredAt'
  ], ['evidence'], field);
  const code = requiredString(detail.code, 128, 'error.code');
  const phase = requiredString(detail.phase, 32, 'error.phase');
  if (!errorCodes.has(code)) throw validationFailure(`${field}.code`, '受支持的错误代码', code);
  if (!errorPhases.has(phase)) throw validationFailure(`${field}.phase`, '受支持的阶段', phase);
  return {
    code,
    phase,
    subject: validatedErrorSubject(detail.subject),
    expected: validatedDiagnosticValue(detail.expected, `${field}.expected`),
    actual: validatedDiagnosticValue(detail.actual, `${field}.actual`),
    message: requiredString(detail.message, Infinity, 'error.message'),
    occurredAt: canonicalTimestamp(detail.occurredAt, 'error.occurredAt'),
    ...(detail.evidence === undefined
      ? {}
      : { evidence: validatedErrorEvidence(detail.evidence) })
  };
}

function optionalEvidenceString(value, field) {
  if (typeof value !== 'string') {
    throw validationFailure(field, '字符串', observedResponseValue(value));
  }
  return value;
}

function validatedErrorEvidence(value, field = 'evidence') {
  const evidence = exactObject(
    value,
    ['type', 'message'],
    ['code', 'stack', 'status', 'body', 'cause', 'errors'],
    field
  );
  const result = {
    type: requiredString(evidence.type, Infinity, `${field}.type`),
    message: requiredString(evidence.message, Infinity, `${field}.message`)
  };
  for (const key of ['code', 'stack', 'body']) {
    if (evidence[key] !== undefined) {
      result[key] = optionalEvidenceString(evidence[key], `${field}.${key}`);
    }
  }
  if (evidence.status !== undefined) {
    if (
      typeof evidence.status !== 'string'
      && (
        typeof evidence.status !== 'number'
        || !Number.isFinite(evidence.status)
      )
    ) {
      throw validationFailure(
        `${field}.status`,
        '字符串或有限数字',
        observedResponseValue(evidence.status)
      );
    }
    result.status = evidence.status;
  }
  if (evidence.cause !== undefined) {
    result.cause = validatedErrorEvidence(
      evidence.cause,
      `${field}.cause`
    );
  }
  if (evidence.errors !== undefined) {
    if (!Array.isArray(evidence.errors)) {
      throw validationFailure(
        `${field}.errors`,
        '证据对象数组',
        observedResponseValue(evidence.errors)
      );
    }
    result.errors = evidence.errors.map((item, index) => (
      validatedErrorEvidence(item, `${field}.errors[${index}]`)
    ));
  }
  return result;
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

function validatedMarket(value, expected, field) {
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
  ], field);
  const result = {
    exchangeId: matchingString(market.exchangeId, expected.exchangeId, 128, `${field}.exchangeId`),
    symbol: matchingString(market.symbol, expected.symbol, 64, `${field}.symbol`),
    marketId: requiredString(market.marketId, 256, `${field}.marketId`),
    kind: matchingString(market.kind, expected.kind, 16, `${field}.kind`),
    base: matchingString(market.base, expected.base, 64, `${field}.base`),
    quote: matchingString(market.quote, 'USDT', 16, `${field}.quote`),
    active: market.active,
    amountStep: positiveDecimalString(market.amountStep, 10_000, `${field}.amountStep`),
    contractSize: positiveDecimalString(market.contractSize, 10_000, `${field}.contractSize`),
    minBaseAmount: nonNegativeDecimalString(market.minBaseAmount, 10_000, `${field}.minBaseAmount`),
    priceStep: positiveDecimalString(market.priceStep, 10_000, `${field}.priceStep`)
  };
  if (result.active !== true) {
    throw validationFailure(`${field}.active`, 'true', typeof result.active === 'boolean' ? String(result.active) : observedResponseValue(result.active));
  }
  for (const [key, positive] of [
    ['maxBaseAmount', true],
    ['minQuoteNotional', false],
    ['maxQuoteNotional', true]
  ]) {
    if (Object.hasOwn(market, key)) {
      result[key] = positive
        ? positiveDecimalString(market[key], 10_000, `${field}.${key}`)
        : nonNegativeDecimalString(market[key], 10_000, `${field}.${key}`);
    }
  }
  if (
    result.maxBaseAmount !== undefined
    && compareDecimals(result.minBaseAmount, result.maxBaseAmount) > 0
  ) {
    throw validationFailure(`${field}.minBaseAmount`, 'minBaseAmount <= maxBaseAmount', `${result.minBaseAmount} > ${result.maxBaseAmount}`);
  }
  if (
    result.minQuoteNotional !== undefined
    && result.maxQuoteNotional !== undefined
    && compareDecimals(
      result.minQuoteNotional,
      result.maxQuoteNotional
    ) > 0
  ) {
    throw validationFailure(`${field}.minQuoteNotional`, 'minQuoteNotional <= maxQuoteNotional', `${result.minQuoteNotional} > ${result.maxQuoteNotional}`);
  }
  return result;
}

function validatedIdentity(value, expectedInput, field = 'preflight') {
  if (!isRecord(value)) {
    throw validationFailure(field, 'JSON 对象', observedResponseValue(value));
  }
  const spotExchangeId = matchingString(value.spotExchangeId, expectedInput.spotExchangeId, 128, `${field}.spotExchangeId`);
  const contractExchangeId = matchingString(value.contractExchangeId, expectedInput.contractExchangeId, 128, `${field}.contractExchangeId`);
  const symbol = matchingString(value.symbol, expectedInput.symbol, 64, `${field}.symbol`);
  const requestedBaseQuantity = positiveDecimalString(value.requestedBaseQuantity, 256, `${field}.requestedBaseQuantity`);
  if (requestedBaseQuantity !== expectedInput.requestedBaseQuantity) {
    throw validationFailure(`${field}.requestedBaseQuantity`, expectedInput.requestedBaseQuantity, requestedBaseQuantity);
  }
  const mode = matchingString(value.mode, expectedInput.mode, 32, `${field}.mode`);
  if (!executionModes.has(mode)) {
    throw validationFailure(`${field}.mode`, [...executionModes].join(', '), mode);
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
  ], [], 'preflight');
  const identity = validatedIdentity(preview, expectedInput);
  const accountSettings = exactObject(preview.accountSettings, [
    'marginMode',
    'positionMode',
    'leverage'
  ], [], 'preflight.accountSettings');
  const marginMode = requiredString(accountSettings.marginMode, 32, `preflight.accountSettings.marginMode`);
  const positionMode = requiredString(accountSettings.positionMode, 32, `preflight.accountSettings.positionMode`);
  if (!['isolated', 'cross'].includes(marginMode)) {
    throw validationFailure('preflight.accountSettings.marginMode', 'isolated 或 cross', marginMode);
  }
  if (positionMode !== 'hedged') {
    throw validationFailure('preflight.accountSettings.positionMode', 'hedged', positionMode);
  }
  const leverage = positiveDecimalString(accountSettings.leverage, 10_000, `preflight.accountSettings.leverage`);
  if (preview.riskAcknowledgementRequired !== true) {
    throw validationFailure('preflight.riskAcknowledgementRequired', 'true', typeof preview.riskAcknowledgementRequired === 'boolean' ? String(preview.riskAcknowledgementRequired) : observedResponseValue(preview.riskAcknowledgementRequired));
  }
  const effectiveBaseQuantity = positiveDecimalString(preview.effectiveBaseQuantity, 10_000, `preflight.effectiveBaseQuantity`);
  if (
    compareDecimals(
      effectiveBaseQuantity,
      identity.requestedBaseQuantity
    ) > 0
  ) {
    throw validationFailure('preflight.effectiveBaseQuantity', 'effectiveBaseQuantity <= requestedBaseQuantity', `${effectiveBaseQuantity} > ${identity.requestedBaseQuantity}`);
  }
  const base = identity.symbol.split('/')[0];
  if (base === undefined || base.length === 0) {
    throw validationFailure('preflight.symbol', '包含非空 base', identity.symbol);
  }
  return {
    ...identity,
    effectiveBaseQuantity,
    spotMarket: validatedMarket(preview.spotMarket, {
      exchangeId: identity.spotExchangeId,
      symbol: identity.symbol,
      kind: 'spot',
      base
    }, 'preflight.spotMarket'),
    contractMarket: validatedMarket(preview.contractMarket, {
      exchangeId: identity.contractExchangeId,
      symbol: identity.symbol,
      kind: 'swap',
      base
    }, 'preflight.contractMarket'),
    spotReferencePrice: positiveDecimalString(preview.spotReferencePrice, 10_000, `preflight.spotReferencePrice`),
    contractReferencePrice: positiveDecimalString(preview.contractReferencePrice, 10_000, `preflight.contractReferencePrice`),
    spotFreeUsdt: positiveDecimalString(preview.spotFreeUsdt, 10_000, `preflight.spotFreeUsdt`),
    contractFreeUsdt: positiveDecimalString(preview.contractFreeUsdt, 10_000, `preflight.contractFreeUsdt`),
    riskAcknowledgementRequired: true,
    accountSettings: {
      marginMode,
      positionMode,
      leverage
    },
    createdAt: canonicalTimestamp(preview.createdAt, `preflight.createdAt`)
  };
}

function validatedPreflightResponse(value, expectedInput) {
  const response = exactObject(
    value,
    ['id', 'state', 'preflight'],
    [],
    'preflight response'
  );
  const id = requiredString(response.id, 128, 'preflight response.id');
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id)) {
    throw validationFailure('preflight response.id', '匹配 ^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$', observedResponseValue(id));
  }
  if (response.state !== 'PENDING_CONFIRMATION') {
    throw validationFailure(
      'preflight response.state',
      '字符串 "PENDING_CONFIRMATION"',
      typeof response.state === 'string'
        ? `字符串 ${JSON.stringify(response.state)}`
        : observedResponseValue(response.state)
    );
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
    'preflightFailure',
    'createdAt',
    'updatedAt'
  ], [], 'strategy');
  const id = matchingString(strategy.id, expectedStrategyId, 128, `strategy.id`);
  const state = requiredString(strategy.state, 32, `strategy.state`);
  if (!strategyStates.has(state)) {
    throw validationFailure('strategy.state', '受支持的状态', state);
  }
  const identity = validatedIdentity(strategy, expectedInput, 'strategy');
  const effectiveBaseQuantity = matchingString(strategy.effectiveBaseQuantity, preview.effectiveBaseQuantity, 10_000, `strategy.effectiveBaseQuantity`);
  const failureCode = strategy.failureCode;
  if (
    failureStates.has(state)
      ? typeof failureCode !== 'string'
        || !strategyFailureCodes.has(failureCode)
      : failureCode !== null
  ) {
    throw validationFailure('strategy.failureCode', failureStates.has(state) ? '合法失败代码' : 'null', typeof failureCode === 'string' && strategyFailureCodes.has(failureCode) ? failureCode : observedResponseValue(failureCode));
  }
  let preflightFailure = null;
  if (state === 'PREFLIGHT_INVALIDATED') {
    preflightFailure = validatedErrorDetail(strategy.preflightFailure, 'strategy.preflightFailure');
  } else if (strategy.preflightFailure !== null) {
    throw validationFailure('strategy.preflightFailure', 'null', observedResponseValue(strategy.preflightFailure));
  }
  const createdAt = canonicalTimestamp(strategy.createdAt, `strategy.createdAt`);
  const updatedAt = canonicalTimestamp(strategy.updatedAt, `strategy.updatedAt`);
  if (new Date(updatedAt).getTime() < new Date(createdAt).getTime()) {
    throw validationFailure('strategy.updatedAt', `createdAt <= updatedAt（createdAt=${createdAt}）`, updatedAt);
  }
  return {
    id,
    state,
    ...identity,
    effectiveBaseQuantity,
    failureCode,
    preflightFailure,
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
  if (globalThis.crypto === undefined) throw validationFailure('crypto', '可用', 'undefined');
  if (globalThis.crypto.subtle === undefined) throw validationFailure('crypto.subtle', '可用', 'undefined');
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
  preview,
  field
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
  const request = exactObject(value, requiredKeys, [], field);
  const baseQuantity = positiveDecimalString(request.baseQuantity, 10_000, `${field}.baseQuantity`);
  if (compareDecimals(baseQuantity, strategy.effectiveBaseQuantity) > 0) {
    throw validationFailure(`${field}.baseQuantity`, `<= strategy.effectiveBaseQuantity ${strategy.effectiveBaseQuantity}`, baseQuantity);
  }
  const result = {
    symbol: matchingString(request.symbol, strategy.symbol, 64, `${field}.symbol`),
    kind: matchingString(request.kind, semantics.kind, 16, `${field}.kind`),
    type: matchingString(request.type, semantics.type, 16, `${field}.type`),
    side: matchingString(request.side, semantics.side, 16, `${field}.side`),
    baseQuantity,
    clientOrderId: matchingString(request.clientOrderId, clientOrderId, 32, `${field}.clientOrderId`)
  };
  if (semantics.hedge) {
    result.price = positiveDecimalString(request.price, 10_000, `${field}.price`);
    result.timeInForce = matchingString(request.timeInForce, 'GTC', 16, `${field}.timeInForce`);
  }
  if (semantics.contract) {
    result.positionSide = matchingString(request.positionSide, 'SHORT', 16, `${field}.positionSide`);
    result.marginMode = matchingString(request.marginMode, preview.accountSettings.marginMode, 16, `${field}.marginMode`);
  }
  return result;
}

function validatedOrderSnapshot(
  value,
  order,
  request,
  orderStatus,
  exchangeOrderId,
  field
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
  ], [], field);
  const status = requiredString(snapshot.status, 16, `${field}.status`);
  if (!snapshotStatuses.has(status)) throw validationFailure(`${field}.status`, '受支持的快照状态', status);
  if (status !== orderStatus) throw validationFailure(`${field}.status`, orderStatus, status);
  const requestedBaseQuantity = positiveDecimalString(snapshot.requestedBaseQuantity, 10_000, `${field}.requestedBaseQuantity`);
  if (compareDecimals(requestedBaseQuantity, request.baseQuantity) !== 0) {
    throw validationFailure(`${field}.requestedBaseQuantity`, request.baseQuantity, requestedBaseQuantity);
  }
  const filledBaseQuantity = nonNegativeDecimalString(snapshot.filledBaseQuantity, 10_000, `${field}.filledBaseQuantity`);
  const remainingBaseQuantity = nonNegativeDecimalString(snapshot.remainingBaseQuantity, 10_000, `${field}.remainingBaseQuantity`);
  if (
    !decimalPartsEqual(
      sumDecimalParts([filledBaseQuantity, remainingBaseQuantity]),
      decimalParts(requestedBaseQuantity)
    )
  ) {
    throw validationFailure(`${field}.filledBaseQuantity`, 'filledBaseQuantity + remainingBaseQuantity = requestedBaseQuantity', `${filledBaseQuantity} + ${remainingBaseQuantity} != ${requestedBaseQuantity}`);
  }
  const averagePrice = snapshot.averagePrice === null
    ? null
    : positiveDecimalString(snapshot.averagePrice, 10_000, `${field}.averagePrice`);
  return {
    exchangeId: matchingString(snapshot.exchangeId, order.exchangeId, 128, `${field}.exchangeId`),
    exchangeOrderId: matchingString(snapshot.exchangeOrderId, exchangeOrderId, 256, `${field}.exchangeOrderId`),
    clientOrderId: matchingString(snapshot.clientOrderId, order.clientOrderId, 32, `${field}.clientOrderId`),
    symbol: matchingString(snapshot.symbol, request.symbol, 64, `${field}.symbol`),
    kind: matchingString(snapshot.kind, request.kind, 16, `${field}.kind`),
    type: matchingString(snapshot.type, request.type, 16, `${field}.type`),
    side: matchingString(snapshot.side, request.side, 16, `${field}.side`),
    requestedBaseQuantity,
    filledBaseQuantity,
    remainingBaseQuantity,
    averagePrice,
    status,
    updatedAt: canonicalTimestamp(snapshot.updatedAt, `${field}.updatedAt`)
  };
}

async function validatedOrder(value, strategy, preview, field) {
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
  ], [], field);
  const id = requiredString(order.id, 36, `${field}.id`);
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
      .test(id)
  ) {
    throw validationFailure(`${field}.id`, 'UUID v4', id);
  }
  matchingString(order.strategyId, strategy.id, 128, `${field}.strategyId`);
  const role = requiredString(order.role, 32, `${field}.role`);
  if (!orderRoles.has(role)) throw validationFailure(`${field}.role`, [...orderRoles].join(', '), role);
  const semantics = expectedOrderSemantics(role, strategy);
  const exchangeId = matchingString(order.exchangeId, semantics.exchangeId, 128, `${field}.exchangeId`);
  const clientOrderId = requiredString(order.clientOrderId, 32, `${field}.clientOrderId`);
  if (!/^[0-9a-f]{32}$/.test(clientOrderId)) throw validationFailure(`${field}.clientOrderId`, '32 位小写十六进制字符串', clientOrderId);
  const deterministicId = await expectedClientOrderId(strategy.id, role);
  if (clientOrderId !== deterministicId) throw validationFailure(`${field}.clientOrderId`, `确定性 ID ${deterministicId}`, clientOrderId);
  const request = validatedOrderRequest(
    order.request,
    strategy,
    clientOrderId,
    semantics,
    preview,
    `${field}.request`
  );
  const status = requiredString(order.status, 16, `${field}.status`);
  if (!orderStatuses.has(status)) {
    throw validationFailure(`${field}.status`, [...orderStatuses].join(', '), status);
  }
  const createdAt = canonicalTimestamp(order.createdAt, `${field}.createdAt`);
  const updatedAt = canonicalTimestamp(order.updatedAt, `${field}.updatedAt`);
  if (new Date(updatedAt).getTime() < new Date(createdAt).getTime()) {
    throw validationFailure(`${field}.updatedAt`, `createdAt <= updatedAt（createdAt=${createdAt}）`, updatedAt);
  }
  let exchangeOrderId = null;
  let snapshot = null;
  if (status === 'planned') {
    if (order.exchangeOrderId !== null || order.snapshot !== null) {
      throw validationFailure(field, 'planned 时 exchangeOrderId 和 snapshot 为 null', `exchangeOrderId=${observedResponseValue(order.exchangeOrderId)}, snapshot=${observedResponseValue(order.snapshot)}`);
    }
  } else {
    exchangeOrderId = requiredString(order.exchangeOrderId, 256, `${field}.exchangeOrderId`);
    snapshot = validatedOrderSnapshot(
      order.snapshot,
      {
        exchangeId,
        clientOrderId
      },
      request,
      status,
      exchangeOrderId,
      `${field}.snapshot`
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
  if (
    strategy.state === 'PENDING_CONFIRMATION'
    || strategy.state === 'PREFLIGHT_INVALIDATED'
  ) {
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

function formatDecimalParts(value) {
  const digits = value.units.toString().padStart(value.scale + 1, '0');
  return value.scale === 0 ? digits : `${digits.slice(0, -value.scale)}.${digits.slice(-value.scale)}`;
}

function validatedActualFills(value, orders) {
  const fills = exactObject(value, [
    'spotBuyBaseQuantity',
    'contractShortBaseQuantity',
    'unmatchedBaseQuantity'
  ], [], 'actualFills');
  const result = {
    spotBuyBaseQuantity: nonNegativeDecimalString(fills.spotBuyBaseQuantity, 10_000, `actualFills.spotBuyBaseQuantity`),
    contractShortBaseQuantity: nonNegativeDecimalString(fills.contractShortBaseQuantity, 10_000, `actualFills.contractShortBaseQuantity`),
    unmatchedBaseQuantity: nonNegativeDecimalString(fills.unmatchedBaseQuantity, 10_000, `actualFills.unmatchedBaseQuantity`)
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
  for (const [field, getExpected] of [
    ['spotBuyBaseQuantity', () => spot],
    ['contractShortBaseQuantity', () => contract],
    ['unmatchedBaseQuantity', () => absoluteDecimalDifference(spot, contract)]
  ]) {
    const expected = getExpected();
    if (!decimalPartsEqual(expected, decimalParts(result[field]))) {
      throw validationFailure(`actualFills.${field}`, formatDecimalParts(expected), result[field]);
    }
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
    || strategy.state === 'PREFLIGHT_INVALIDATED'
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
  ], [], 'status');
  if (
    !Array.isArray(response.orders)
    || response.orders.length > orderRoles.size
  ) {
    throw validationFailure('status.orders', `数组，长度最多 ${orderRoles.size}`, observedResponseValue(response.orders));
  }
  const preview = validatedPreview(response.preflight, expectedInput);
  const strategy = validatedStrategy(
    response.strategy,
    expectedInput,
    expectedStrategyId,
    preview
  );
  const orders = await Promise.all(
    response.orders.map((order, index) => validatedOrder(order, strategy, preview, `orders[${index}]`))
  );
  const roleSet = new Set(orders.map((order) => order.role));
  const clientIdSet = new Set(orders.map((order) => order.clientOrderId));
  const orderIdSet = new Set(orders.map((order) => order.id));
  for (const [field, unique] of [['role', roleSet], ['clientOrderId', clientIdSet], ['id', orderIdSet]]) {
    if (unique.size !== orders.length) throw validationFailure(`status.orders.${field}`, '每个订单唯一', `${unique.size} 个唯一值 / ${orders.length} 个订单`);
  }
  if (!orderTopologyMatchesStrategy(strategy, orders)) {
    throw validationFailure('status.orders.topology', `mode=${strategy.mode}, state=${strategy.state} 对应的订单角色集合`, `roles=${orders.map((order) => order.role).join(',')}`);
  }
  const actualFills = validatedActualFills(response.actualFills, orders);
  if (!orderExecutionMatchesStrategy(strategy, orders, actualFills)) {
    throw validationFailure('status.orders.execution', `mode=${strategy.mode}, state=${strategy.state} 的成交、残差和补单规则`, orders.map((order) => `${order.role}: status=${order.status}, requested=${order.request.baseQuantity}, filled=${order.snapshot?.filledBaseQuantity ?? 'missing'}, remaining=${order.snapshot?.remainingBaseQuantity ?? 'missing'}, averagePrice=${order.snapshot?.averagePrice ?? 'missing'}`).join('; '));
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
    throw validationFailure('preflight', 'JSON 对象', observedResponseValue(value));
  }
  const spotExchangeId = requiredString(value.spotExchangeId, 128, `preflight.spotExchangeId`);
  const contractExchangeId = requiredString(value.contractExchangeId, 128, `preflight.contractExchangeId`);
  for (const [field, id] of [['spotExchangeId', spotExchangeId], ['contractExchangeId', contractExchangeId]]) {
    if (!configuredExchangeIds.has(id)) throw validationFailure(`preflight.${field}`, '已配置交易所', id);
  }
  for (const [field, id] of [['spotExchangeId', spotExchangeId], ['contractExchangeId', contractExchangeId]]) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id)) throw validationFailure(`preflight.${field}`, '合法交易所 ID', id);
  }
  if (spotExchangeId === contractExchangeId) throw validationFailure('preflight.contractExchangeId', '与 spotExchangeId 不同', contractExchangeId);
  const symbol = requiredString(value.symbol, 64, `preflight.symbol`);
  if (!/^[A-Z0-9][A-Z0-9._-]{0,30}\/USDT$/.test(symbol)) {
    throw validationFailure('preflight.symbol', '大写 BASE/USDT', symbol);
  }
  const requestedBaseQuantity = positiveDecimalString(value.requestedBaseQuantity, 256, `preflight.requestedBaseQuantity`);
  const mode = requiredString(value.mode, 32, `preflight.mode`);
  if (!executionModes.has(mode)) {
    throw validationFailure('preflight.mode', [...executionModes].join(', '), mode);
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
    throw validationFailure('status', 'JSON 对象', observedResponseValue(value));
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
  return response.json();
}

class OperatorRequestError extends Error {
  constructor(operatorMessage) {
    super(operatorMessage);
    this.operatorMessage = operatorMessage;
  }
}

function boundedOperatorLine(label, value) {
  return `${label}：${value}`;
}

function safeThrownMessage(error) {
  if ((typeof error !== 'object' && typeof error !== 'function') || error === null) {
    return undefined;
  }
  try {
    const descriptor = Object.getOwnPropertyDescriptor(error, 'message');
    return descriptor !== undefined
      && Object.hasOwn(descriptor, 'value')
      && typeof descriptor.value === 'string'
      && descriptor.value.length > 0
      ? descriptor.value
      : undefined;
  } catch {
    return undefined;
  }
}

function formattedSubject(subject) {
  switch (subject.type) {
    case 'configuration':
    case 'request':
      return `${subject.type} · field=${subject.field}`;
    case 'exchange':
      return `${subject.type} · exchangeId=${subject.exchangeId}`
        + ` · operation=${subject.operation}`;
    case 'market':
      return `${subject.type} · exchangeId=${subject.exchangeId}`
        + ` · symbol=${subject.symbol} · kind=${subject.kind}`
        + (subject.field === undefined ? '' : ` · field=${subject.field}`);
    case 'account':
      return `${subject.type} · exchangeId=${subject.exchangeId}`
        + ` · symbol=${subject.symbol} · field=${subject.field}`;
    case 'strategy':
      return `${subject.type} · strategyId=${subject.strategyId}`
        + (subject.field === undefined ? '' : ` · field=${subject.field}`);
    case 'database': {
      const parts = ['path', 'table', 'recordId', 'field', 'operation']
        .filter((key) => subject[key] !== undefined)
        .map((key) => `${key}=${subject[key]}`);
      return [subject.type, ...parts].join(' · ');
    }
    default:
      throw new Error('invalid formatted subject');
  }
}

function formattedDiagnostic(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `[${value.join(', ')}]`;
  return String(value);
}

function detailLines(detail) {
  return [
    boundedOperatorLine('代码', detail.code),
    boundedOperatorLine('消息', detail.message),
    boundedOperatorLine('阶段', detail.phase),
    boundedOperatorLine('对象', formattedSubject(detail.subject)),
    boundedOperatorLine('期望', formattedDiagnostic(detail.expected)),
    boundedOperatorLine('实际', formattedDiagnostic(detail.actual)),
    ...(detail.evidence === undefined
      ? []
      : evidenceLines(detail.evidence))
  ];
}

function evidenceLines(evidence, label = '证据') {
  const lines = [
    boundedOperatorLine(`${label}类型`, evidence.type),
    boundedOperatorLine(`${label}消息`, evidence.message)
  ];
  for (const [key, keyLabel] of [
    ['code', '代码'],
    ['stack', '堆栈'],
    ['status', '状态'],
    ['body', '正文']
  ]) {
    if (evidence[key] !== undefined) {
      lines.push(boundedOperatorLine(`${label}${keyLabel}`, evidence[key]));
    }
  }
  if (evidence.cause !== undefined) {
    lines.push(...evidenceLines(evidence.cause, `${label}.cause`));
  }
  if (evidence.errors !== undefined) {
    evidence.errors.forEach((item, index) => {
      lines.push(...evidenceLines(item, `${label}.errors[${index}]`));
    });
  }
  return lines;
}

function invalidationMessage(detail) {
  return [
    detail.message,
    '预检已失效，请重新预检。',
    ...detailLines(detail)
  ].join('\n');
}

function serverFailureMessage(operation, response, body) {
  try {
    const envelope = exactObject(
      body,
      ['requestId', 'error'],
      [],
      'error envelope'
    );
    const requestId = requiredString(
      envelope.requestId,
      2000,
      'error envelope.requestId'
    );
    const detail = validatedErrorDetail(envelope.error);
    return [
      detail.message,
      `${operation}失败`,
      `HTTP ${response.status}`,
      ...detailLines(detail),
      boundedOperatorLine('请求 ID', requestId)
    ].join('\n');
  } catch (error) {
    return [
      safeThrownMessage(error) ?? '错误响应结构检查失败',
      `${operation}失败`,
      `HTTP ${response.status}`,
      '响应不是有效的结构化 JSON 错误'
    ].join('\n');
  }
}

async function requestJson(operation, url, options, expectedStatus) {
  let response;
  try {
    response = await fetch(url, options);
  } catch (error) {
    const reason = safeThrownMessage(error);
    throw new OperatorRequestError(
      reason === undefined
        ? `${operation}失败\n网络请求失败`
        : [reason, `${operation}失败`, '网络请求失败'].join('\n')
    );
  }
  let body;
  try {
    body = await responseJson(response);
  } catch (error) {
    const message = safeThrownMessage(error);
    const location = message?.match(/(?:at position|position) ([0-9]+)(?: \(line ([0-9]+) column ([0-9]+)\))?$/u);
    const diagnostic = location === null || location === undefined
      ? '响应 JSON 解析失败：语法位置不可安全获取'
      : `响应 JSON 语法检查失败：位置 ${location[1]}`
        + (location[2] === undefined ? '' : `，行 ${location[2]}，列 ${location[3]}`);
    throw new OperatorRequestError([diagnostic, `${operation}失败`, `HTTP ${response.status}`].join('\n'));
  }
  if (response.status !== expectedStatus) {
    throw new OperatorRequestError(
      serverFailureMessage(operation, response, body)
    );
  }
  return body;
}

function operatorFailureMessage(operation, error) {
  if (error instanceof OperatorRequestError) {
    return error.operatorMessage;
  }
  return [
    safeThrownMessage(error) ?? '响应结构检查失败',
    `${operation}失败`,
    '响应校验失败：响应结构无效'
  ].join('\n');
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
    displayedStrategyState = status.strategy.state;
    if (!preflightReady) {
      riskAck.checked = false;
    }
    renderStatus(status);
    if (status.strategy.state === 'PREFLIGHT_INVALIDATED') {
      setMessage(
        invalidationMessage(status.strategy.preflightFailure),
        'error'
      );
    } else {
      setMessage('状态已刷新。', 'success');
    }
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
    displayedStrategyState = loaded.status.strategy.state;
    riskAck.checked = false;
    renderStatus(loaded.status);
    refreshButton.disabled = false;
    if (loaded.status.strategy.state === 'PREFLIGHT_INVALIDATED') {
      setMessage(
        invalidationMessage(loaded.status.strategy.preflightFailure),
        'error'
      );
    } else {
      setMessage(
        preflightReady
          ? '对冲任务已加载。请核对状态并重新确认风险。'
          : '对冲任务已加载，仅供查看。',
        'success'
      );
    }
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
    displayedStrategyState = preflight.state;
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
      riskAck.checked = false;
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
      throw validationFailure('exchanges', '数组', observedResponseValue(body?.exchanges));
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
