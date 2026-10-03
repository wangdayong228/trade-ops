import { isProxy } from 'node:util/types';

const ERROR_CODES = [
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
] as const;

const ERROR_PHASES = [
  'startup',
  'request',
  'preflight',
  'confirmation',
  'storage'
] as const;

const SUBJECT_TYPES = [
  'configuration',
  'request',
  'exchange',
  'market',
  'account',
  'strategy',
  'database'
] as const;

const ERROR_CODE_SET = new Set<string>(ERROR_CODES);
const ERROR_PHASE_SET = new Set<string>(ERROR_PHASES);
const SUBJECT_TYPE_SET = new Set<string>(SUBJECT_TYPES);
const IDENTIFIER_LIMIT = 128;
const SYMBOL_LIMIT = 64;
const PATH_LIMIT = 512;
const DIAGNOSTIC_STRING_LIMIT = 2_000;
const DIAGNOSTIC_LIST_LIMIT = 16;

export type ErrorCode = typeof ERROR_CODES[number];
export type ErrorPhase = typeof ERROR_PHASES[number];
export type SafeDiagnosticValue =
  | string
  | number
  | boolean
  | null
  | readonly string[];

export interface ConfigurationErrorSubject {
  readonly type: 'configuration';
  readonly field: string;
}

export interface RequestErrorSubject {
  readonly type: 'request';
  readonly field: string;
}

export interface ExchangeErrorSubject {
  readonly type: 'exchange';
  readonly exchangeId: string;
  readonly operation: string;
}

export interface MarketErrorSubject {
  readonly type: 'market';
  readonly exchangeId: string;
  readonly symbol: string;
  readonly kind: string;
  readonly field?: string;
}

export interface AccountErrorSubject {
  readonly type: 'account';
  readonly exchangeId: string;
  readonly symbol: string;
  readonly field: string;
}

export interface StrategyErrorSubject {
  readonly type: 'strategy';
  readonly strategyId: string;
  readonly field?: string;
}

export interface DatabaseErrorSubject {
  readonly type: 'database';
  readonly path?: string;
  readonly table?: string;
  readonly recordId?: string;
  readonly field?: string;
  readonly operation?: string;
}

export type ErrorSubject =
  | ConfigurationErrorSubject
  | RequestErrorSubject
  | ExchangeErrorSubject
  | MarketErrorSubject
  | AccountErrorSubject
  | StrategyErrorSubject
  | DatabaseErrorSubject;

export interface ErrorInput {
  readonly code: ErrorCode;
  readonly phase: ErrorPhase;
  readonly subject: ErrorSubject;
  readonly expected: SafeDiagnosticValue;
  readonly actual: SafeDiagnosticValue;
  readonly occurredAt?: string;
}

export interface ErrorDetail extends Omit<ErrorInput, 'occurredAt'> {
  readonly message: string;
  readonly occurredAt: string;
}

type DataProperties = ReadonlyMap<PropertyKey, PropertyDescriptor>;

const ERROR_DESCRIPTIONS: Readonly<Record<ErrorCode, string>> = {
  CONFIG_FIELD_MISSING: '配置项缺失检查失败',
  CONFIG_FIELD_INVALID: '配置项有效性检查失败',
  DATABASE_OPEN_FAILED: '数据库打开检查失败',
  DATABASE_SCHEMA_VERSION_MISMATCH: '数据库 schema 版本检查失败',
  DATABASE_OWNERSHIP_BUSY: '数据库独占所有权占用检查失败',
  DATABASE_OWNERSHIP_UNAVAILABLE: '数据库独占所有权可用性检查失败',
  SERVICE_COMPONENT_FAILED: '服务组件启动检查失败',
  SERVICE_LISTEN_FAILED: '服务监听检查失败',
  REQUEST_FORBIDDEN: '请求来源安全检查失败',
  REQUEST_BODY_INVALID: '请求正文结构检查失败',
  REQUEST_FIELD_INVALID: '请求字段有效性检查失败',
  STRATEGY_NOT_FOUND: '策略存在性检查失败',
  STRATEGY_STATE_MISMATCH: '策略状态检查失败',
  STRATEGY_OPERATION_BUSY: '策略操作所有权检查失败',
  EXCHANGE_NOT_CONFIGURED: '交易所配置检查失败',
  MARKET_UNAVAILABLE: '市场可用性检查失败',
  MARKET_IDENTITY_MISMATCH: '市场身份检查失败',
  MARKET_INACTIVE: '市场可交易状态检查失败',
  MARKET_RULE_INVALID: '市场规则检查失败',
  ACCOUNT_SETTINGS_UNAVAILABLE: '账户设置读取检查失败',
  ACCOUNT_SETTINGS_CONFLICT: '账户设置一致性检查失败',
  ACCOUNT_POSITION_MODE_MISMATCH: '账户持仓模式检查失败',
  ACCOUNT_MARGIN_MODE_MISMATCH: '账户保证金模式检查失败',
  ACCOUNT_LEVERAGE_MISMATCH: '账户杠杆检查失败',
  QUANTITY_INVALID: '数量有效性检查失败',
  QUANTITY_NOT_REPRESENTABLE: '数量精度可表示性检查失败',
  QUANTITY_OUT_OF_RANGE: '数量范围检查失败',
  PRICE_UNAVAILABLE: '价格可用性检查失败',
  PRICE_INVALID: '价格有效性检查失败',
  NOTIONAL_OUT_OF_RANGE: '名义金额范围检查失败',
  BALANCE_UNAVAILABLE: '余额可用性检查失败',
  BALANCE_INSUFFICIENT: '余额充足性检查失败',
  PREFLIGHT_INVALIDATED: '确认复检有效性检查失败',
  STORAGE_OPERATION_FAILED: '存储操作检查失败',
  STORAGE_RECORD_INVALID: '存储记录完整性检查失败',
  STORAGE_TRANSITION_REJECTED: '存储状态转换检查失败'
};

const ERROR_DETAILS = new WeakMap<object, ErrorDetail>();

function invalid(
  path: string,
  expected: string,
  actual: string
): never {
  throw new TypeError(
    `错误契约 ${path} 校验失败：期望 ${expected}，实际为 ${actual}`
  );
}

function valueCategory(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  return typeof value;
}

function recordProperties(value: unknown, path: string): DataProperties {
  if (typeof value !== 'object' || value === null) {
    return invalid(path, '普通数据对象', valueCategory(value));
  }
  if (isProxy(value)) {
    return invalid(path, '非 Proxy 的普通数据对象', 'Proxy 对象');
  }

  let prototype: object | null;
  let descriptors: PropertyDescriptorMap;
  try {
    prototype = Object.getPrototypeOf(value) as object | null;
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    return invalid(path, '可检查的普通数据对象', '不可检查对象');
  }
  if (prototype !== Object.prototype && prototype !== null) {
    return invalid(path, '普通数据对象', '带有自定义原型的对象');
  }

  const properties = new Map<PropertyKey, PropertyDescriptor>();
  for (const key of Reflect.ownKeys(descriptors)) {
    const descriptor = Reflect.get(descriptors, key) as PropertyDescriptor;
    if (!('value' in descriptor) || descriptor.get !== undefined
      || descriptor.set !== undefined) {
      return invalid(path, '仅含数据属性', '包含访问器属性');
    }
    properties.set(key, descriptor);
  }
  return properties;
}

function assertExactProperties(
  properties: DataProperties,
  path: string,
  allowed: readonly string[],
  required: readonly string[]
): void {
  let unexpectedCount = 0;
  for (const key of properties.keys()) {
    if (typeof key !== 'string' || !allowed.includes(key)) {
      unexpectedCount += 1;
    }
  }
  if (unexpectedCount > 0) {
    invalid(path, '仅含已定义字段', `包含 ${unexpectedCount} 个额外字段`);
  }
  for (const key of required) {
    if (!properties.has(key)) {
      invalid(`${path}.${key}`, '必填数据属性', '字段缺失');
    }
  }
}

function propertyValue(properties: DataProperties, key: string): unknown {
  return properties.get(key)?.value;
}

function enumProperty<T extends string>(
  properties: DataProperties,
  key: string,
  values: ReadonlySet<string>,
  expected: string
): T {
  const value = propertyValue(properties, key);
  if (typeof value !== 'string') {
    return invalid(key, expected, valueCategory(value));
  }
  if (!values.has(value)) {
    return invalid(key, expected, '未识别字符串');
  }
  return value as T;
}

function redact(value: string, secrets: readonly string[]): string {
  let safe = value;
  let changed: boolean;
  do {
    changed = false;
    for (const secret of secrets) {
      if (safe.includes(secret)) {
        safe = safe.split(secret).join('');
        changed = true;
      }
    }
  } while (changed);
  return safe;
}

function boundedString(
  value: unknown,
  path: string,
  limit: number,
  secrets: readonly string[],
  allowEmpty = false
): string {
  if (typeof value !== 'string') {
    return invalid(path, `长度不超过 ${limit} 的字符串`, valueCategory(value));
  }
  if (value.length > limit) {
    return invalid(path, `原始长度不超过 ${limit}`, `原始长度为 ${value.length}`);
  }
  const safe = redact(value, secrets);
  if (!allowEmpty && safe.length === 0) {
    return invalid(path, '非空字符串', '长度为 0');
  }
  if (safe.length > limit) {
    return invalid(path, `长度不超过 ${limit}`, `长度为 ${safe.length}`);
  }
  return safe;
}

function stringProperty(
  properties: DataProperties,
  key: string,
  path: string,
  limit: number,
  secrets: readonly string[]
): string {
  return boundedString(propertyValue(properties, key), path, limit, secrets);
}

function optionalStringProperty(
  properties: DataProperties,
  key: string,
  path: string,
  limit: number,
  secrets: readonly string[]
): string | undefined {
  if (!properties.has(key)) {
    return undefined;
  }
  return stringProperty(properties, key, path, limit, secrets);
}

function denseArrayValues(value: unknown, path: string): readonly unknown[] {
  if (typeof value !== 'object' || value === null) {
    return invalid(path, '数组', valueCategory(value));
  }
  if (isProxy(value)) {
    return invalid(path, '非 Proxy 数组', 'Proxy 对象');
  }

  let isArray: boolean;
  let prototype: object | null;
  let descriptors: PropertyDescriptorMap;
  try {
    isArray = Array.isArray(value);
    prototype = Object.getPrototypeOf(value) as object | null;
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    return invalid(path, '可检查的数组', '不可检查对象');
  }
  if (!isArray || prototype !== Array.prototype) {
    return invalid(path, '普通数组', '非普通数组对象');
  }

  const lengthDescriptor = descriptors.length;
  if (lengthDescriptor === undefined || !('value' in lengthDescriptor)
    || typeof lengthDescriptor.value !== 'number') {
    return invalid(`${path}.length`, '数组长度数据属性', '无效长度属性');
  }
  const length = lengthDescriptor.value;
  const expectedKeys = new Set<PropertyKey>(['length']);
  const result: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const key = String(index);
    expectedKeys.add(key);
    const descriptor = descriptors[key];
    if (descriptor === undefined || !('value' in descriptor)
      || descriptor.get !== undefined || descriptor.set !== undefined) {
      return invalid(`${path}[${index}]`, '数据属性', '缺失或访问器属性');
    }
    result.push(descriptor.value);
  }
  for (const key of Reflect.ownKeys(descriptors)) {
    if (!expectedKeys.has(key)) {
      return invalid(path, '无额外属性的稠密数组', '包含额外或稀疏属性');
    }
  }
  return result;
}

function normalizeSecrets(secrets: readonly string[] | undefined): readonly string[] {
  if (secrets === undefined) {
    return Object.freeze([]);
  }
  const rawSecrets = denseArrayValues(secrets, 'secrets');
  const unique = new Set<string>();
  for (const secret of rawSecrets) {
    if (typeof secret !== 'string') {
      invalid('secrets[]', '非空字符串', valueCategory(secret));
    }
    if (secret.length === 0) {
      invalid('secrets[]', '非空字符串', '长度为 0');
    }
    unique.add(secret);
  }
  return Object.freeze([...unique].sort((left, right) => right.length - left.length));
}

function parseSubject(value: unknown, secrets: readonly string[]): ErrorSubject {
  const properties = recordProperties(value, 'subject');
  if (!properties.has('type')) {
    invalid('subject.type', '必填对象类型', '字段缺失');
  }
  const type = enumProperty<typeof SUBJECT_TYPES[number]>(
    properties,
    'type',
    SUBJECT_TYPE_SET,
    '已定义对象类型'
  );

  switch (type) {
    case 'configuration':
    case 'request': {
      assertExactProperties(properties, 'subject', ['type', 'field'], ['type', 'field']);
      return Object.freeze({
        type,
        field: stringProperty(
          properties,
          'field',
          `subject.${type}.field`,
          IDENTIFIER_LIMIT,
          secrets
        )
      });
    }
    case 'exchange': {
      assertExactProperties(
        properties,
        'subject',
        ['type', 'exchangeId', 'operation'],
        ['type', 'exchangeId', 'operation']
      );
      return Object.freeze({
        type,
        exchangeId: stringProperty(
          properties, 'exchangeId', 'subject.exchange.exchangeId',
          IDENTIFIER_LIMIT, secrets
        ),
        operation: stringProperty(
          properties, 'operation', 'subject.exchange.operation',
          IDENTIFIER_LIMIT, secrets
        )
      });
    }
    case 'market': {
      assertExactProperties(
        properties,
        'subject',
        ['type', 'exchangeId', 'symbol', 'kind', 'field'],
        ['type', 'exchangeId', 'symbol', 'kind']
      );
      const field = optionalStringProperty(
        properties, 'field', 'subject.market.field', IDENTIFIER_LIMIT, secrets
      );
      return Object.freeze({
        type,
        exchangeId: stringProperty(
          properties, 'exchangeId', 'subject.market.exchangeId',
          IDENTIFIER_LIMIT, secrets
        ),
        symbol: stringProperty(
          properties, 'symbol', 'subject.market.symbol', SYMBOL_LIMIT, secrets
        ),
        kind: stringProperty(
          properties, 'kind', 'subject.market.kind', IDENTIFIER_LIMIT, secrets
        ),
        ...(field === undefined ? {} : { field })
      });
    }
    case 'account': {
      assertExactProperties(
        properties,
        'subject',
        ['type', 'exchangeId', 'symbol', 'field'],
        ['type', 'exchangeId', 'symbol', 'field']
      );
      return Object.freeze({
        type,
        exchangeId: stringProperty(
          properties, 'exchangeId', 'subject.account.exchangeId',
          IDENTIFIER_LIMIT, secrets
        ),
        symbol: stringProperty(
          properties, 'symbol', 'subject.account.symbol', SYMBOL_LIMIT, secrets
        ),
        field: stringProperty(
          properties, 'field', 'subject.account.field', IDENTIFIER_LIMIT, secrets
        )
      });
    }
    case 'strategy': {
      assertExactProperties(
        properties,
        'subject',
        ['type', 'strategyId', 'field'],
        ['type', 'strategyId']
      );
      const field = optionalStringProperty(
        properties, 'field', 'subject.strategy.field', IDENTIFIER_LIMIT, secrets
      );
      return Object.freeze({
        type,
        strategyId: stringProperty(
          properties, 'strategyId', 'subject.strategy.strategyId',
          IDENTIFIER_LIMIT, secrets
        ),
        ...(field === undefined ? {} : { field })
      });
    }
    case 'database': {
      assertExactProperties(
        properties,
        'subject',
        ['type', 'path', 'table', 'recordId', 'field', 'operation'],
        ['type']
      );
      const path = optionalStringProperty(
        properties, 'path', 'subject.database.path', PATH_LIMIT, secrets
      );
      const table = optionalStringProperty(
        properties, 'table', 'subject.database.table', IDENTIFIER_LIMIT, secrets
      );
      const recordId = optionalStringProperty(
        properties, 'recordId', 'subject.database.recordId', IDENTIFIER_LIMIT, secrets
      );
      const field = optionalStringProperty(
        properties, 'field', 'subject.database.field', IDENTIFIER_LIMIT, secrets
      );
      const operation = optionalStringProperty(
        properties, 'operation', 'subject.database.operation', IDENTIFIER_LIMIT, secrets
      );
      return Object.freeze({
        type,
        ...(path === undefined ? {} : { path }),
        ...(table === undefined ? {} : { table }),
        ...(recordId === undefined ? {} : { recordId }),
        ...(field === undefined ? {} : { field }),
        ...(operation === undefined ? {} : { operation })
      });
    }
  }
}

function parseDiagnosticValue(
  value: unknown,
  path: string,
  secrets: readonly string[]
): SafeDiagnosticValue {
  if (value === null || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      return invalid(path, '有限数字', '非有限数字');
    }
    return value;
  }
  if (typeof value === 'string') {
    return boundedString(
      value,
      path,
      DIAGNOSTIC_STRING_LIMIT,
      secrets,
      true
    );
  }
  if (typeof value !== 'object') {
    return invalid(
      path,
      '字符串、有限数字、布尔值、null 或字符串列表',
      valueCategory(value)
    );
  }

  const items = denseArrayValues(value, path);
  if (items.length > DIAGNOSTIC_LIST_LIMIT) {
    return invalid(
      path,
      `不超过 ${DIAGNOSTIC_LIST_LIMIT} 项的字符串列表`,
      `包含 ${items.length} 项`
    );
  }
  const safeItems = items.map((item, index) => boundedString(
    item,
    `${path}[${index}]`,
    DIAGNOSTIC_STRING_LIMIT,
    secrets,
    true
  ));
  return Object.freeze(safeItems);
}

function canonicalTimestamp(value: unknown): string {
  if (typeof value !== 'string') {
    return invalid('occurredAt', 'UTC ISO 8601 时间字符串', valueCategory(value));
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) {
    return invalid('occurredAt', '规范 UTC ISO 8601 时间字符串', '格式不匹配');
  }
  const instant = new Date(value);
  if (Number.isNaN(instant.getTime()) || instant.toISOString() !== value) {
    return invalid('occurredAt', '有效 UTC ISO 8601 时间字符串', '无效日期时间');
  }
  return value;
}

function isCredentialField(subject: ErrorSubject): boolean {
  return subject.type === 'configuration'
    && /(?:API_?KEY|SECRET|PASSWORD|PASSPHRASE|TOKEN|PRIVATE_?KEY)/iu.test(
      subject.field
    );
}

function encodeMessageString(value: string): string {
  return JSON.stringify(value);
}

function describeSubject(subject: ErrorSubject): string {
  switch (subject.type) {
    case 'configuration':
      return `配置项字段 ${encodeMessageString(subject.field)}`;
    case 'request':
      return `请求字段 ${encodeMessageString(subject.field)}`;
    case 'exchange':
      return `交易所 ${encodeMessageString(subject.exchangeId)}`
        + ` 操作 ${encodeMessageString(subject.operation)}`;
    case 'market':
      return [
        `交易所 ${encodeMessageString(subject.exchangeId)}`,
        `市场 ${encodeMessageString(subject.symbol)}`,
        `类型 ${encodeMessageString(subject.kind)}`,
        ...(subject.field === undefined
          ? []
          : [`字段 ${encodeMessageString(subject.field)}`])
      ].join('、');
    case 'account':
      return [
        `交易所 ${encodeMessageString(subject.exchangeId)}`,
        `账户市场 ${encodeMessageString(subject.symbol)}`,
        `字段 ${encodeMessageString(subject.field)}`
      ].join('、');
    case 'strategy':
      return [
        `策略 ${encodeMessageString(subject.strategyId)}`,
        ...(subject.field === undefined
          ? []
          : [`字段 ${encodeMessageString(subject.field)}`])
      ].join('、');
    case 'database': {
      const parts = [
        ...(subject.path === undefined
          ? []
          : [`路径 ${encodeMessageString(subject.path)}`]),
        ...(subject.table === undefined
          ? []
          : [`表 ${encodeMessageString(subject.table)}`]),
        ...(subject.recordId === undefined
          ? []
          : [`记录 ${encodeMessageString(subject.recordId)}`]),
        ...(subject.field === undefined
          ? []
          : [`字段 ${encodeMessageString(subject.field)}`]),
        ...(subject.operation === undefined
          ? []
          : [`操作 ${encodeMessageString(subject.operation)}`])
      ];
      return parts.length === 0
        ? '数据库对象'
        : `数据库${parts.join('、')}`;
    }
  }
}

function describeDiagnostic(value: SafeDiagnosticValue): string {
  if (value === null) {
    return '空值 null';
  }
  if (typeof value === 'string') {
    return `字符串 ${encodeMessageString(value)}`;
  }
  if (typeof value === 'number') {
    return `数值 ${Object.is(value, -0) ? '-0' : String(value)}`;
  }
  if (typeof value === 'boolean') {
    return `布尔值 ${String(value)}`;
  }
  return `字符串列表 ${JSON.stringify(value)}`;
}

function createMessage(
  code: ErrorCode,
  subject: ErrorSubject,
  expected: SafeDiagnosticValue,
  actual: SafeDiagnosticValue
): string {
  return `${ERROR_DESCRIPTIONS[code]}（${describeSubject(subject)}）：`
    + `期望 ${describeDiagnostic(expected)}，实际为 ${describeDiagnostic(actual)}`;
}

function buildDetail(
  input: unknown,
  rawSecrets: readonly string[] | undefined
): ErrorDetail {
  const secrets = normalizeSecrets(rawSecrets);
  const properties = recordProperties(input, 'input');
  assertExactProperties(
    properties,
    'input',
    ['code', 'phase', 'subject', 'expected', 'actual', 'occurredAt'],
    ['code', 'phase', 'subject', 'expected', 'actual']
  );

  const code = enumProperty<ErrorCode>(
    properties, 'code', ERROR_CODE_SET, '已定义错误码'
  );
  const phase = enumProperty<ErrorPhase>(
    properties, 'phase', ERROR_PHASE_SET, '已定义错误阶段'
  );
  const rawSubject = propertyValue(properties, 'subject');
  const originalSubject = parseSubject(rawSubject, []);
  const rawActual = propertyValue(properties, 'actual');
  const credentialField = isCredentialField(originalSubject);
  if (credentialField
    && rawActual !== 'missing'
    && rawActual !== 'present-but-invalid') {
    invalid(
      'actual',
      '凭证安全类别 missing 或 present-but-invalid',
      '非允许凭证类别'
    );
  }
  const subject = secrets.length === 0
    ? originalSubject
    : parseSubject(rawSubject, secrets);
  const expected = parseDiagnosticValue(
    propertyValue(properties, 'expected'), 'expected', secrets
  );
  const actual = parseDiagnosticValue(
    rawActual, 'actual', secrets
  );
  if (credentialField
    && actual !== 'missing'
    && actual !== 'present-but-invalid') {
    invalid(
      'actual',
      '脱敏后仍为凭证缺失或凭证存在但无效类别',
      '脱敏后为非允许凭证类别'
    );
  }

  const occurredAt = properties.has('occurredAt')
    ? canonicalTimestamp(propertyValue(properties, 'occurredAt'))
    : new Date().toISOString();
  const message = createMessage(code, subject, expected, actual);
  return Object.freeze({
    code,
    phase,
    subject,
    expected,
    actual,
    message,
    occurredAt
  });
}

export class TradeOpsError extends Error {
  public readonly detail: ErrorDetail;

  public constructor(input: ErrorInput, secrets?: readonly string[]) {
    const detail = buildDetail(input, secrets);
    super(detail.message);
    this.name = 'TradeOpsError';
    this.detail = detail;
    ERROR_DETAILS.set(this, detail);
    Object.freeze(this);
  }
}

export function createTradeOpsError(
  input: ErrorInput,
  secrets?: readonly string[]
): TradeOpsError {
  return new TradeOpsError(input, secrets);
}

export function withErrorPhase(
  error: TradeOpsError,
  phase: ErrorPhase
): TradeOpsError {
  const detail = ERROR_DETAILS.get(error);
  if (detail === undefined) {
    return invalid('error', '由错误工厂创建的 TradeOpsError', '未知错误对象');
  }
  if (typeof phase !== 'string' || !ERROR_PHASE_SET.has(phase)) {
    return invalid('phase', '已定义错误阶段', '未识别阶段');
  }
  return createTradeOpsError({
    code: detail.code,
    phase,
    subject: detail.subject,
    expected: detail.expected,
    actual: detail.actual,
    occurredAt: detail.occurredAt
  });
}

export function parseErrorDetail(value: unknown): ErrorDetail {
  const properties = recordProperties(value, 'persistedDetail');
  assertExactProperties(
    properties,
    'persistedDetail',
    ['code', 'phase', 'subject', 'expected', 'actual', 'message', 'occurredAt'],
    ['code', 'phase', 'subject', 'expected', 'actual', 'message', 'occurredAt']
  );
  const storedMessage = propertyValue(properties, 'message');
  if (typeof storedMessage !== 'string') {
    return invalid('persistedDetail.message', '工厂生成的字符串', valueCategory(storedMessage));
  }

  const rebuilt = buildDetail({
    code: propertyValue(properties, 'code'),
    phase: propertyValue(properties, 'phase'),
    subject: propertyValue(properties, 'subject'),
    expected: propertyValue(properties, 'expected'),
    actual: propertyValue(properties, 'actual'),
    occurredAt: propertyValue(properties, 'occurredAt')
  }, undefined);
  if (storedMessage !== rebuilt.message) {
    return invalid(
      'persistedDetail.message',
      '与结构字段一致的工厂消息',
      '消息与字段不一致'
    );
  }
  return rebuilt;
}

export function safeFailureCategory(error: unknown): string {
  if (error === null) {
    return 'null-thrown';
  }
  switch (typeof error) {
    case 'undefined':
      return 'undefined-thrown';
    case 'string':
      return 'string-thrown';
    case 'number':
      return 'number-thrown';
    case 'boolean':
      return 'boolean-thrown';
    case 'bigint':
      return 'bigint-thrown';
    case 'symbol':
      return 'symbol-thrown';
    case 'function':
      return 'function-failure';
    case 'object':
      return 'object-failure';
  }
  return 'unknown-thrown';
}
