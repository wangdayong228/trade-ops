'use strict';

const REFRESH_MS = 10_000;
const coverageLabels = { PENDING: '待回填', BACKFILLING: '回填中', CAUGHT_UP: '已覆盖', INCOMPLETE: '未完成' };
const incrementalLabels = { IDLE: '空闲', RUNNING: '增量中', INCOMPLETE: '未完成' };
const phaseLabels = { STARTING: '启动中', RUNNING: '运行中', STOPPING: '关闭中', STOPPED: '已停止' };
const fundingLabels = { NOT_STARTED: '尚未启动', RUNNING: '运行中', STOPPED: '已停止', FAILED: '同步故障' };
const discoveryLabels = { NEVER: '尚无发现结果', SUCCEEDED: '最近发现成功', INCOMPLETE: '最近发现未完成' };
const PAUSED_REQUEST = Symbol('page paused');
const byId = (id) => document.getElementById(id);
let lastSnapshot = null;
let refreshTimer = null;
let controller = null;
let inFlight = false;
let disposed = false;
let refreshAfterRequest = false;

function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
}

function invalid(field, expected, actual) {
  throw new Error(`状态响应 ${field} 检查失败：期望 ${expected}，实际 ${JSON.stringify(actual)}`);
}

function object(value, field) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid(field, '对象', value);
  return value;
}

function enumValue(value, choices, field) {
  if (typeof value !== 'string' || !Object.hasOwn(choices, value)) invalid(field, Object.keys(choices).join(' / '), value);
}

function integer(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) invalid(field, '非负安全整数', value);
}

function timestamp(value, field, nullable = true) {
  if (nullable && value === null) return;
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) invalid(field, 'UTC ISO 时间', value);
}

function evidence(value, field) {
  object(value, field);
  for (const key of ['type', 'message']) {
    if (typeof value[key] !== 'string' || !value[key]) invalid(`${field}.${key}`, '非空字符串', value[key]);
  }
  for (const key of ['code', 'body']) {
    if (value[key] !== undefined && typeof value[key] !== 'string') invalid(`${field}.${key}`, '字符串', value[key]);
  }
  if (value.status !== undefined && typeof value.status !== 'string' && !Number.isFinite(value.status)) invalid(`${field}.status`, '字符串或有限数值', value.status);
  if (value.cause !== undefined) evidence(value.cause, `${field}.cause`);
  if (value.errors !== undefined) {
    if (!Array.isArray(value.errors)) invalid(`${field}.errors`, '错误数组', value.errors);
    value.errors.forEach((error, index) => evidence(error, `${field}.errors[${index}]`));
  }
}

function validateSnapshot(data) {
  object(data, 'response');
  timestamp(data.generatedAt, 'generatedAt', false);
  object(data.service, 'service');
  enumValue(data.status, { ready: 1, not_ready: 1 }, 'status');
  enumValue(data.service.phase, phaseLabels, 'service.phase');
  timestamp(data.service.startedAt, 'service.startedAt');
  integer(data.service.uptimeMs, 'service.uptimeMs');
  if (data.service.phase === 'RUNNING' && data.service.startedAt === null) invalid('service.startedAt', '运行服务的启动时间', null);
  if (data.service.startedAt === null && data.service.uptimeMs !== 0) invalid('service.uptimeMs', '未启动时为 0', data.service.uptimeMs);
  object(data.database, 'database');
  enumValue(data.database.status, { ok: 1, error: 1 }, 'database.status');
  const expectedReadiness = data.service.phase === 'RUNNING' && data.database.status === 'ok' ? 'ready' : 'not_ready';
  if (data.status !== expectedReadiness) invalid('status', expectedReadiness, data.status);
  if (data.database.status === 'error') evidence(data.database.error, 'database.error');
  object(data.funding, 'funding');
  enumValue(data.funding.status, fundingLabels, 'funding.status');
  if (data.funding.status === 'FAILED') {
    object(data.funding.lastFatal, 'funding.lastFatal');
    timestamp(data.funding.lastFatal.at, 'funding.lastFatal.at', false);
    evidence(data.funding.lastFatal.error, 'funding.lastFatal.error');
  } else if (data.funding.lastFatal !== null) invalid('funding.lastFatal', '非故障状态为 null', data.funding.lastFatal);
  integer(data.funding.intervalMs, 'funding.intervalMs');
  if (data.funding.intervalMs < 60_000) invalid('funding.intervalMs', '至少 60000 毫秒', data.funding.intervalMs);
  if (!Array.isArray(data.funding.exchanges) || data.funding.exchanges.length !== 2) invalid('funding.exchanges', 'Bitget 与 OKX 两项', data.funding.exchanges);
  const seen = new Set();
  for (const exchange of data.funding.exchanges) {
    object(exchange, 'exchange');
    enumValue(exchange.exchangeId, { bitget: 1, okx: 1 }, 'exchangeId');
    if (seen.has(exchange.exchangeId)) invalid('exchangeId', '两交易所不重复', exchange.exchangeId);
    seen.add(exchange.exchangeId);
    object(exchange.discovery, 'discovery');
    enumValue(exchange.discovery.status, discoveryLabels, 'discovery.status');
    timestamp(exchange.discovery.lastAttemptAt, 'discovery.lastAttemptAt');
    timestamp(exchange.discovery.lastSuccessAt, 'discovery.lastSuccessAt');
    const discovery = exchange.discovery;
    if (discovery.status === 'NEVER') {
      for (const key of ['lastAttemptAt', 'lastSuccessAt', 'observedActiveCount', 'observedInactiveCount', 'error']) {
        if (discovery[key] !== null) invalid(`discovery.${key}`, '尚无发现结果时为 null', discovery[key]);
      }
    } else {
      timestamp(discovery.lastAttemptAt, 'discovery.lastAttemptAt', false);
      if (discovery.status === 'INCOMPLETE') evidence(discovery.error, 'discovery.error');
      else {
        if (discovery.lastSuccessAt !== discovery.lastAttemptAt) invalid('discovery.lastSuccessAt', discovery.lastAttemptAt, discovery.lastSuccessAt);
        if (discovery.error !== null) invalid('discovery.error', '成功结果为 null', discovery.error);
      }
      for (const key of ['observedActiveCount', 'observedInactiveCount']) {
        if (discovery.lastSuccessAt !== null) integer(discovery[key], `discovery.${key}`);
        else if (discovery[key] !== null) invalid(`discovery.${key}`, '尚未成功发现时为 null', discovery[key]);
      }
    }
    object(exchange.counts, 'counts');
    for (const key of ['total', 'active', 'inactive']) integer(exchange.counts[key], `counts.${key}`);
    for (const [key, labels] of [['coverage', coverageLabels], ['incremental', incrementalLabels]]) {
      object(exchange.counts[key], `counts.${key}`);
      for (const status of Object.keys(labels)) integer(exchange.counts[key][status], `counts.${key}.${status}`);
    }
    const activeTotal = exchange.counts.active + exchange.counts.inactive;
    if (activeTotal !== exchange.counts.total) invalid('counts.active + counts.inactive', exchange.counts.total, activeTotal);
    for (const [category, labels] of [['coverage', coverageLabels], ['incremental', incrementalLabels]]) {
      const total = Object.keys(labels).reduce((sum, status) => sum + exchange.counts[category][status], 0);
      if (total !== exchange.counts.total) invalid(`counts.${category} 合计`, exchange.counts.total, total);
    }
  }
  return data;
}

function dateText(value) {
  return value === null ? '尚无记录' : new Date(value).toISOString().replace('T', ' ').replace('.000Z', ' UTC').replace('Z', ' UTC');
}

function badge(label, tone = '') {
  return node('span', label, `status-badge ${tone}`);
}

function statusBadge(status, labels) {
  const tone = status === 'INCOMPLETE' || status === 'FAILED' ? 'status-bad'
    : status === 'CAUGHT_UP' || status === 'SUCCEEDED' ? 'status-good' : 'status-warn';
  return badge(labels[status], tone);
}

function details(title, value) {
  const container = node('details');
  container.append(node('summary', title), node('pre', JSON.stringify(value, null, 2)));
  return container;
}

function card(title, value, note) {
  const element = node('div', undefined, 'status-card');
  element.append(node('h3', title), node('p', value, 'status-value'), node('p', note, 'status-secondary'));
  return element;
}

function serviceOverview(data) {
  const result = document.createDocumentFragment();
  result.append(
    card('HTTP 服务', data.status === 'ready' ? '就绪' : '未就绪', `服务阶段：${phaseLabels[data.service.phase]}`),
    card('数据库', data.database.status === 'ok' ? '可访问' : '访问失败', '本次快照的数据库检查结果'),
    card('资金费率同步器', fundingLabels[data.funding.status], `调度周期：${data.funding.intervalMs / 1000} 秒`),
    card('本次服务运行', `${Math.floor(data.service.uptimeMs / 60_000)} 分钟`, `启动：${dateText(data.service.startedAt)}`)
  );
  if (data.database.status === 'error') result.append(details('数据库检查失败详情', data.database.error));
  if (data.funding.lastFatal) result.append(details(`同步器故障 · ${dateText(data.funding.lastFatal.at)}`, data.funding.lastFatal.error));
  return result;
}

function exchangeOverview(data) {
  const result = document.createDocumentFragment();
  for (const exchange of data.funding.exchanges) {
    const element = node('div', undefined, 'exchange-card');
    const discovery = exchange.discovery;
    element.append(node('h3', exchange.exchangeId === 'okx' ? 'OKX' : 'Bitget'), statusBadge(discovery.status, discoveryLabels));
    element.append(node('p', `最近发现结束：${dateText(discovery.lastAttemptAt)}`, 'status-secondary'));
    element.append(node('p', `最近发现成功：${dateText(discovery.lastSuccessAt)}`, 'status-secondary'));
    if (discovery.observedActiveCount !== null) element.append(node('p', `上次成功观察：活跃 ${discovery.observedActiveCount} / 非活跃 ${discovery.observedInactiveCount}`, 'status-secondary'));
    element.append(node('p', `已知市场 ${exchange.counts.total} · 活跃 ${exchange.counts.active} · 非活跃 ${exchange.counts.inactive}`));
    element.append(node('p', `全范围：${Object.entries(coverageLabels).map(([key, label]) => `${label} ${exchange.counts.coverage[key]}`).join(' / ')}`));
    element.append(node('p', `增量：${Object.entries(incrementalLabels).map(([key, label]) => `${label} ${exchange.counts.incremental[key]}`).join(' / ')}`));
    if (discovery.error) element.append(details('市场发现失败详情', discovery.error));
    result.append(element);
  }
  return result;
}

function renderSnapshot(data) {
  const service = serviceOverview(data);
  const exchanges = exchangeOverview(data);
  byId('service-overview').replaceChildren(service);
  byId('exchange-overview').replaceChildren(exchanges);
}

async function refreshStatus() {
  if (inFlight || disposed || document.hidden) return;
  clearTimeout(refreshTimer);
  inFlight = true;
  byId('status-refresh').disabled = true;
  controller = new AbortController();
  const requestController = controller;
  const timeout = setTimeout(() => requestController.abort(new Error('GET /api/status 请求超过 10 秒，未取得最新状态')), REFRESH_MS);
  try {
    const response = await fetch('/api/status', { cache: 'no-store', signal: requestController.signal });
    const body = await response.json();
    if (!response.ok) throw new Error(`GET /api/status 返回 HTTP ${response.status}：${JSON.stringify(body)}`);
    const data = validateSnapshot(body);
    if (disposed || document.hidden || requestController.signal.reason === PAUSED_REQUEST) return;
    renderSnapshot(data);
    lastSnapshot = data;
    byId('status-content').dataset.stale = 'false';
    byId('snapshot-age').textContent = `最近成功获取：${dateText(data.generatedAt)}`;
    byId('status-message').textContent = '';
  } catch (error) {
    if (disposed || document.hidden || requestController.signal.reason === PAUSED_REQUEST) return;
    byId('status-content').dataset.stale = 'true';
    byId('status-message').textContent = `刷新失败：${error instanceof Error ? error.message : String(error)}`;
    byId('snapshot-age').textContent = lastSnapshot === null ? '尚未取得可用状态' : `数据已过期，以下为历史快照：${dateText(lastSnapshot.generatedAt)}`;
  } finally {
    clearTimeout(timeout);
    controller = null;
    inFlight = false;
    byId('status-refresh').disabled = false;
    const refreshImmediately = refreshAfterRequest;
    refreshAfterRequest = false;
    if (!disposed && !document.hidden) {
      if (refreshImmediately) void refreshStatus();
      else refreshTimer = setTimeout(refreshStatus, REFRESH_MS);
    }
  }
}

function resumeRefresh() {
  if (inFlight) refreshAfterRequest = true;
  else void refreshStatus();
}

byId('status-refresh').addEventListener('click', refreshStatus);
document.addEventListener('visibilitychange', () => {
  clearTimeout(refreshTimer);
  if (document.hidden) controller?.abort(PAUSED_REQUEST);
  else resumeRefresh();
});
window.addEventListener('pagehide', () => {
  disposed = true;
  clearTimeout(refreshTimer);
  controller?.abort(PAUSED_REQUEST);
});
window.addEventListener('pageshow', () => {
  disposed = false;
  resumeRefresh();
});
void refreshStatus();
