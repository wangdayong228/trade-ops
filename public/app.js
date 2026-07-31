const spotExchange = document.querySelector('#spot-exchange');
const contractExchange = document.querySelector('#contract-exchange');
const symbolInput = document.querySelector('#symbol');
const quantityInput = document.querySelector('#base-quantity');
const modeInput = document.querySelector('#mode');
const preflightForm = document.querySelector('#preflight-form');
const preflightButton = document.querySelector('#preflight-button');
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
  if (!isRecord(value) || !isRecord(value.accountSettings)) {
    throw new Error('invalid preflight preview');
  }
  const identity = validatedIdentity(value, expectedInput);
  const accountSettings = value.accountSettings;
  const marginMode = requiredString(accountSettings.marginMode, 32);
  const positionMode = requiredString(accountSettings.positionMode, 32);
  if (!['isolated', 'cross'].includes(marginMode)) {
    throw new Error('invalid margin mode');
  }
  if (!['one-way', 'hedged'].includes(positionMode)) {
    throw new Error('invalid position mode');
  }
  const leverage = positiveDecimalString(accountSettings.leverage);
  if (value.riskAcknowledgementRequired !== true) {
    throw new Error('invalid risk acknowledgement requirement');
  }
  return {
    ...identity,
    effectiveBaseQuantity: positiveDecimalString(
      value.effectiveBaseQuantity
    ),
    spotReferencePrice: positiveDecimalString(value.spotReferencePrice),
    contractReferencePrice: positiveDecimalString(
      value.contractReferencePrice
    ),
    spotFreeUsdt: positiveDecimalString(value.spotFreeUsdt),
    contractFreeUsdt: positiveDecimalString(value.contractFreeUsdt),
    riskAcknowledgementRequired: true,
    accountSettings: {
      marginMode,
      positionMode,
      leverage
    }
  };
}

function validatedPreflightResponse(value, expectedInput) {
  if (!isRecord(value)) {
    throw new Error('invalid preflight response');
  }
  const id = requiredString(value.id, 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id)) {
    throw new Error('invalid strategy id');
  }
  if (value.state !== 'PENDING_CONFIRMATION') {
    throw new Error('invalid preflight state');
  }
  return {
    id,
    state: value.state,
    preflight: validatedPreview(value.preflight, expectedInput)
  };
}

function validatedStatusResponse(
  value,
  expectedInput,
  expectedStrategyId
) {
  if (
    !isRecord(value)
    || !isRecord(value.strategy)
    || !Array.isArray(value.orders)
    || !isRecord(value.actualFills)
  ) {
    throw new Error('invalid status response');
  }
  const state = requiredString(value.strategy.state, 32);
  if (!strategyStates.has(state)) {
    throw new Error('invalid strategy state');
  }
  const strategyId = matchingString(
    value.strategy.id,
    expectedStrategyId,
    128
  );
  const strategyIdentity = validatedIdentity(
    value.strategy,
    expectedInput
  );
  const orders = value.orders.map((order) => {
    if (!isRecord(order)) {
      throw new Error('invalid order');
    }
    const role = requiredString(order.role, 32);
    if (!orderRoles.has(role)) {
      throw new Error('invalid order role');
    }
    const exchangeOrderId = order.exchangeOrderId;
    if (
      exchangeOrderId !== null
      && typeof exchangeOrderId !== 'string'
    ) {
      throw new Error('invalid exchange order id');
    }
    return {
      role,
      clientOrderId: requiredString(order.clientOrderId, 256),
      exchangeOrderId
    };
  });
  return {
    strategy: {
      id: strategyId,
      state,
      ...strategyIdentity
    },
    preflight: validatedPreview(value.preflight, expectedInput),
    orders,
    actualFills: {
      spotBuyBaseQuantity: nonNegativeDecimalString(
        value.actualFills.spotBuyBaseQuantity
      ),
      contractShortBaseQuantity: nonNegativeDecimalString(
        value.actualFills.contractShortBaseQuantity
      ),
      unmatchedBaseQuantity: nonNegativeDecimalString(
        value.actualFills.unmatchedBaseQuantity
      )
    }
  };
}

function renderPreflight(strategy) {
  const preview = strategy.preflight;
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
  updateConfirmButton();
  try {
    const response = await fetch(
      `/api/hedges/${encodeURIComponent(statusStrategyId)}`,
      { headers: { accept: 'application/json' } }
    );
    const body = await responseJson(response);
    if (!response.ok || body === null) {
      throw new Error('status unavailable');
    }
    const status = validatedStatusResponse(
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
    renderStatus(status);
    setMessage('状态已刷新。', 'success');
  } catch {
    if (
      statusRevision === inputRevision
      && statusStrategyId === strategyId
    ) {
      resetActionablePreview(
        '状态响应无效或刷新失败，请重新预检。',
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
      updateConfirmButton();
    }
  }
}

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
  updateConfirmButton();
  setMessage('正在预检，请稍候。');
  try {
    const response = await fetch('/api/hedges/preflight', {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json'
      },
      body: JSON.stringify(submittedInput)
    });
    const body = await responseJson(response);
    if (response.status !== 201 || body === null) {
      throw new Error('preflight rejected');
    }
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
  } catch {
    if (submittedRevision === inputRevision) {
      resetActionablePreview(
        '预检未通过，请检查参数和账户状态。',
        'error'
      );
    }
  } finally {
    if (submittedRevision === inputRevision) {
      requestPending = false;
      preflightButton.disabled = false;
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
  updateConfirmButton();
  setMessage('正在提交确认。');
  try {
    const response = await fetch(
      `/api/hedges/${encodeURIComponent(confirmedStrategyId)}/confirm`,
      {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json'
        },
        body: JSON.stringify({ riskAcknowledged: true })
      }
    );
    if (response.status !== 202) {
      throw new Error('confirmation rejected');
    }
    if (
      confirmationRevision !== inputRevision
      || confirmedStrategyId !== strategyId
    ) {
      return;
    }
    setMessage('确认已受理，正在后台执行', 'success');
  } catch {
    if (
      confirmationRevision === inputRevision
      && confirmedStrategyId === strategyId
    ) {
      preflightReady = true;
      setMessage('确认未受理，请重试或重新预检。', 'error');
    }
  } finally {
    if (
      confirmationRevision === inputRevision
      && confirmedStrategyId === strategyId
    ) {
      requestPending = false;
      preflightButton.disabled = false;
      refreshButton.disabled = false;
      updateConfirmButton();
    }
  }
});

refreshButton.addEventListener('click', refreshStatus);

async function loadExchanges() {
  try {
    const response = await fetch('/api/exchanges', {
      headers: { accept: 'application/json' }
    });
    const body = await responseJson(response);
    if (!response.ok || !Array.isArray(body?.exchanges)) {
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
  } catch {
    setMessage('交易所列表加载失败，请刷新页面。', 'error');
  }
}

clearPreview();
updateConfirmButton();
void loadExchanges();
