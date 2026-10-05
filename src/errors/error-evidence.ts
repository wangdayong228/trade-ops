import { isProxy } from 'node:util/types';

export interface ErrorEvidence {
  readonly type: string;
  readonly message: string;
  readonly code?: string;
  readonly stack?: string;
  readonly status?: string | number;
  readonly body?: string;
  readonly cause?: ErrorEvidence;
  readonly errors?: readonly ErrorEvidence[];
}

const DEFAULT_REDACTION = '[Redacted]';
const SENSITIVE_KEY = '(?:api[_-]?key|secret|password|passwd|passphrase|token|access[_-]?token|authorization|signature|private[_-]?key|seed|cookie|credentials|auth)';
const SENSITIVE_KEY_VALUE = new RegExp(`^${SENSITIVE_KEY}$`, 'iu');
const NATIVE_ERROR_CONSTRUCTOR = Error;
const NATIVE_OBJECT_PROTOTYPE = Object.prototype;

function escapedPattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function encodedPattern(value: string): string {
  return [...encodeURIComponent(value)].map((character) => {
    if (/[A-F]/u.test(character)) {
      return `[${character}${character.toLowerCase()}]`;
    }
    return escapedPattern(character);
  }).join('');
}

function redactionMarker(secrets: readonly string[]): string {
  for (const candidate of [DEFAULT_REDACTION, '[Masked]', '[Hidden]']) {
    if (secrets.every((secret) => !candidate.includes(secret))) {
      return candidate;
    }
  }
  for (let codePoint = 0xe000; codePoint <= 0xf8ff; codePoint += 1) {
    const candidate = String.fromCodePoint(codePoint);
    if (secrets.every((secret) => !candidate.includes(secret))) {
      return candidate;
    }
  }
  return '';
}

function jsonStringEnd(value: string, start: number): number {
  let escaped = false;
  for (let index = start + 1; index < value.length; index += 1) {
    const character = value[index];
    if (escaped) {
      escaped = false;
    } else if (character === '\\') {
      escaped = true;
    } else if (character === '"') {
      return index + 1;
    }
  }
  return value.length;
}

function jsonValueEnd(value: string, start: number): number {
  const first = value[start];
  if (first === '"') return jsonStringEnd(value, start);
  if (first === '{' || first === '[') {
    const expectedClosers: string[] = [first === '{' ? '}' : ']'];
    let inString = false;
    let escaped = false;
    for (let index = start + 1; index < value.length; index += 1) {
      const character = value[index];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (character === '\\') {
          escaped = true;
        } else if (character === '"') {
          inString = false;
        }
        continue;
      }
      if (character === '"') {
        inString = true;
      } else if (character === '{') {
        expectedClosers.push('}');
      } else if (character === '[') {
        expectedClosers.push(']');
      } else if (character === expectedClosers.at(-1)) {
        expectedClosers.pop();
        if (expectedClosers.length === 0) return index + 1;
      }
    }
    return value.length;
  }
  let end = start;
  while (end < value.length && !/[\s,}\]]/u.test(value[end] ?? '')) end += 1;
  return end;
}

function redactJsonValues(value: string, marker: string): string {
  let safe = value;
  let index = 0;
  while (index < safe.length) {
    if (safe[index] !== '"') {
      index += 1;
      continue;
    }
    const tokenEnd = jsonStringEnd(safe, index);
    let separator = tokenEnd;
    while (/\s/u.test(safe[separator] ?? '')) separator += 1;
    if (safe[separator] !== ':') {
      index = tokenEnd;
      continue;
    }
    let key: unknown;
    try {
      key = JSON.parse(safe.slice(index, tokenEnd));
    } catch {
      index = tokenEnd;
      continue;
    }
    if (typeof key !== 'string' || !SENSITIVE_KEY_VALUE.test(key)) {
      index = tokenEnd;
      continue;
    }
    let valueStart = separator + 1;
    while (/\s/u.test(safe[valueStart] ?? '')) valueStart += 1;
    const valueEnd = jsonValueEnd(safe, valueStart);
    const replacement = `"${marker}"`;
    safe = `${safe.slice(0, valueStart)}${replacement}${safe.slice(valueEnd)}`;
    index = valueStart + replacement.length;
  }
  return safe;
}

function redactUrlValues(value: string, marker: string): string {
  return value.replace(
    /([?&])([^=&#\s]+)=([^&#\s]*)/gu,
    (matched, separator: string, rawKey: string) => {
      let decodedKey: string;
      try {
        decodedKey = decodeURIComponent(rawKey.replaceAll('+', ' '));
      } catch {
        return matched;
      }
      return SENSITIVE_KEY_VALUE.test(decodedKey)
        ? `${separator}${rawKey}=${marker}`
        : matched;
    }
  );
}

function normalizedSecrets(secrets: readonly string[] | undefined): readonly string[] {
  if (secrets === undefined || isProxy(secrets) || !Array.isArray(secrets)) {
    return [];
  }
  let lengthDescriptor: PropertyDescriptor | undefined;
  try {
    lengthDescriptor = Object.getOwnPropertyDescriptor(secrets, 'length');
  } catch {
    return [];
  }
  const length = lengthDescriptor?.value;
  if (!Number.isSafeInteger(length) || length < 0) {
    return [];
  }
  const values: string[] = [];
  for (let index = 0; index < length; index += 1) {
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(secrets, String(index));
    } catch {
      continue;
    }
    if (descriptor === undefined || !('value' in descriptor)
      || typeof descriptor.value !== 'string' || descriptor.value.length === 0) {
      continue;
    }
    values.push(descriptor.value);
  }
  return [...new Set(values)].sort((left, right) => right.length - left.length);
}

export function redactEvidenceText(
  value: string,
  secrets: readonly string[] = []
): string {
  const configuredSecrets = normalizedSecrets(secrets);
  const marker = redactionMarker(configuredSecrets);
  let safe = value;
  safe = safe.replace(
    /-----BEGIN ((?:[A-Z0-9]+ )*PRIVATE KEY)-----[\s\S]*?-----END \1-----/giu,
    marker
  );
  safe = safe.replace(
    /\bAuthorization\s*:\s*[^\s,"'}]+\s+[^\s,"'}]+/giu,
    `Authorization: ${marker}`
  );
  safe = safe.replace(/\bBearer\s+[^\s,"'}]+/giu, `Bearer ${marker}`);
  safe = redactUrlValues(safe, marker);
  safe = redactJsonValues(safe, marker);
  safe = safe.replace(
    new RegExp(`(^|[\\s;&])(${SENSITIVE_KEY}\\s*[:=]\\s*)[^\\s,;&]+`, 'giu'),
    `$1$2${marker}`
  );
  for (const secret of configuredSecrets) {
    const jsonEncoded = JSON.stringify(secret).slice(1, -1);
    if (jsonEncoded !== secret) safe = safe.replaceAll(jsonEncoded, marker);
    safe = safe.replaceAll(secret, marker);
    const encoded = encodedPattern(secret);
    if (encoded !== escapedPattern(secret)) {
      safe = safe.replace(new RegExp(encoded, 'gu'), marker);
      safe = safe.replaceAll(encodeURIComponent(secret).replaceAll('%20', '+'), marker);
    }
  }
  return safe;
}

export function diagnosticValue(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'undefined':
      return 'undefined';
    case 'string':
      return `string ${JSON.stringify(value)}`;
    case 'boolean':
      return `boolean ${String(value)}`;
    case 'number':
      return `number ${Object.is(value, -0) ? '-0' : String(value)}`;
    case 'bigint':
      return `bigint ${String(value)}n`;
    case 'symbol':
      return 'symbol value';
    case 'function':
      return 'function value';
    case 'object':
      return isProxy(value) ? 'unreadable Proxy object' : 'object value';
  }
  return 'unknown value';
}

type InspectedProperty = {
  readonly kind: 'absent' | 'accessor' | 'data' | 'unreadable';
  readonly value?: unknown;
};

function inspectedProperty(
  descriptor: PropertyDescriptor | undefined
): InspectedProperty {
  if (descriptor === undefined) return { kind: 'absent' };
  if (!('value' in descriptor) || descriptor.get !== undefined
    || descriptor.set !== undefined) {
    return { kind: 'accessor' };
  }
  return { kind: 'data', value: descriptor.value };
}

function ownProperty(value: object, property: string): InspectedProperty {
  try {
    return inspectedProperty(Object.getOwnPropertyDescriptor(value, property));
  } catch {
    return { kind: 'unreadable' };
  }
}

function inheritedProperty(value: object, property: string): InspectedProperty {
  const visited = new WeakSet<object>();
  let current: object | null = value;
  while (current !== null) {
    if (isProxy(current) || visited.has(current)) return { kind: 'unreadable' };
    visited.add(current);
    const inspected = ownProperty(current, property);
    if (inspected.kind !== 'absent') return inspected;
    try {
      current = Object.getPrototypeOf(current) as object | null;
    } catch {
      return { kind: 'unreadable' };
    }
  }
  return { kind: 'absent' };
}

function propertyIsUnreadable(property: InspectedProperty): boolean {
  return property.kind === 'accessor' || property.kind === 'unreadable';
}

function propertyIsSafeForStack(property: InspectedProperty): boolean {
  if (property.kind === 'absent') return true;
  if (property.kind !== 'data') return false;
  return property.value === null
    || ['undefined', 'string', 'number', 'boolean', 'bigint'].includes(
      typeof property.value
    );
}

function evidenceMarker(
  message: string,
  secrets: readonly string[]
): string {
  const safe = redactEvidenceText(message, secrets);
  return safe.length === 0 ? DEFAULT_REDACTION : safe;
}

function requiredEvidenceText(
  value: string,
  emptyMessage: string,
  secrets: readonly string[]
): string {
  const safe = redactEvidenceText(value, secrets);
  return safe.length === 0 ? evidenceMarker(emptyMessage, secrets) : safe;
}

function stringEvidenceProperty(
  property: InspectedProperty,
  path: string,
  secrets: readonly string[]
): string | undefined {
  switch (property.kind) {
    case 'absent':
      return undefined;
    case 'accessor':
      return evidenceMarker(`${path} accessor is unreadable`, secrets);
    case 'unreadable':
      return evidenceMarker(`${path} descriptor is unreadable`, secrets);
    case 'data':
      return typeof property.value === 'string'
        ? redactEvidenceText(property.value, secrets)
        : evidenceMarker(`${path} has unsupported non-string value`, secrets);
  }
}

function statusEvidenceProperty(
  property: InspectedProperty,
  path: string,
  secrets: readonly string[]
): string | number | undefined {
  if (property.kind === 'absent') return undefined;
  if (property.kind === 'accessor') {
    return evidenceMarker(`${path} accessor is unreadable`, secrets);
  }
  if (property.kind === 'unreadable') {
    return evidenceMarker(`${path} descriptor is unreadable`, secrets);
  }
  if (typeof property.value === 'string') {
    return redactEvidenceText(property.value, secrets);
  }
  if (typeof property.value === 'number' && Number.isFinite(property.value)) {
    return property.value;
  }
  return evidenceMarker(`${path} has unsupported status value`, secrets);
}

function objectRealmState(
  value: object
): 'current' | 'other' | 'unreadable' {
  const visited = new WeakSet<object>();
  let current: object | null = value;
  while (current !== null) {
    if (current === NATIVE_OBJECT_PROTOTYPE) return 'current';
    if (isProxy(current) || visited.has(current)) return 'unreadable';
    visited.add(current);
    try {
      current = Object.getPrototypeOf(current) as object | null;
    } catch {
      return 'unreadable';
    }
  }
  return 'other';
}

export type ErrorStackDescriptorInspection =
  | {
      readonly kind: 'descriptor';
      readonly descriptor: PropertyDescriptor | undefined;
    }
  | {
      readonly kind: 'unreadable';
      readonly reason: string;
    };

function readStackDescriptor(value: object): ErrorStackDescriptorInspection {
  try {
    return {
      kind: 'descriptor',
      descriptor: Object.getOwnPropertyDescriptor(value, 'stack')
    };
  } catch {
    return { kind: 'unreadable', reason: 'stack descriptor is unreadable' };
  }
}

export function inspectErrorStackDescriptor(
  value: object
): ErrorStackDescriptorInspection {
  const nameProperty = inheritedProperty(value, 'name');
  if (!propertyIsSafeForStack(nameProperty)) {
    return {
      kind: 'unreadable',
      reason: 'error name cannot be safely read for stack formatting'
    };
  }
  const messageProperty = inheritedProperty(value, 'message');
  if (!propertyIsSafeForStack(messageProperty)) {
    return {
      kind: 'unreadable',
      reason: 'error message cannot be safely read for stack formatting'
    };
  }

  const realmState = objectRealmState(value);
  if (realmState === 'unreadable') {
    return {
      kind: 'unreadable',
      reason: 'the prototype chain is unsafe'
    };
  }
  if (realmState === 'other') {
    return {
      kind: 'unreadable',
      reason: 'the object realm is unknown'
    };
  }

  let formatter: PropertyDescriptor | undefined;
  try {
    formatter = Object.getOwnPropertyDescriptor(
      NATIVE_ERROR_CONSTRUCTOR, 'prepareStackTrace'
    );
  } catch {
    return {
      kind: 'unreadable',
      reason: 'Error.prepareStackTrace descriptor is unreadable'
    };
  }
  if (formatter === undefined
    || ('value' in formatter && formatter.value === undefined)) {
    return readStackDescriptor(value);
  }
  if (!('value' in formatter)) {
    return {
      kind: 'unreadable',
      reason: 'Error.prepareStackTrace accessor is unreadable'
    };
  }
  if (formatter.configurable !== true && formatter.writable !== true) {
    return {
      kind: 'unreadable',
      reason: 'Error.prepareStackTrace cannot be safely disabled'
    };
  }

  let disabled = false;
  let inspection: ErrorStackDescriptorInspection = {
    kind: 'unreadable',
    reason: 'Error.prepareStackTrace could not be disabled'
  };
  try {
    Object.defineProperty(NATIVE_ERROR_CONSTRUCTOR, 'prepareStackTrace', {
      ...formatter,
      value: undefined
    });
    disabled = true;
    inspection = readStackDescriptor(value);
  } catch {
    inspection = {
      kind: 'unreadable',
      reason: 'Error.prepareStackTrace could not be disabled'
    };
  } finally {
    if (disabled) {
      try {
        Object.defineProperty(
          NATIVE_ERROR_CONSTRUCTOR, 'prepareStackTrace', formatter
        );
      } catch {
        inspection = {
          kind: 'unreadable',
          reason: 'Error.prepareStackTrace could not be restored'
        };
      }
    }
  }
  return inspection;
}

function stackEvidenceProperty(
  value: object,
  includeStack: boolean,
  nameProperty: InspectedProperty,
  messageProperty: InspectedProperty,
  secrets: readonly string[]
): string | undefined {
  if (!includeStack
    || !propertyIsSafeForStack(nameProperty)
    || !propertyIsSafeForStack(messageProperty)) {
    return undefined;
  }
  const inspected = inspectErrorStackDescriptor(value);
  if (inspected.kind === 'unreadable') {
    return evidenceMarker(`stack is unreadable because ${inspected.reason}`, secrets);
  }
  return stringEvidenceProperty(
    inspectedProperty(inspected.descriptor), 'stack', secrets
  );
}

function unreadable(property: string, reason: string): ErrorEvidence {
  return Object.freeze({
    type: 'UnreadableErrorEvidence',
    message: `${property} ${reason}`
  });
}

function primitiveEvidence(value: unknown, secrets: readonly string[]): ErrorEvidence {
  return Object.freeze({
    type: value === null ? 'null' : typeof value,
    message: redactEvidenceText(diagnosticValue(value), secrets)
  });
}

function arrayValues(value: unknown): readonly unknown[] | undefined {
  if (typeof value !== 'object' || value === null || isProxy(value)
    || !Array.isArray(value)) {
    return undefined;
  }
  const lengthProperty = ownProperty(value, 'length');
  const length = lengthProperty.value;
  if (lengthProperty.kind !== 'data'
    || !Number.isSafeInteger(length) || typeof length !== 'number' || length < 0) {
    return undefined;
  }
  const values: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const item = ownProperty(value, String(index));
    if (item.kind !== 'data') {
      return undefined;
    }
    values.push(item.value);
  }
  return values;
}

function responseEvidence(
  response: unknown,
  secrets: readonly string[]
): Pick<ErrorEvidence, 'status' | 'body'> {
  if (typeof response !== 'object' || response === null || isProxy(response)) {
    return {
      status: evidenceMarker(
        'response.status is unreadable because response is not a safe object',
        secrets
      ),
      body: evidenceMarker(
        'response.body is unreadable because response is not a safe object',
        secrets
      )
    };
  }
  const statusProperty = ownProperty(response, 'status');
  const bodyProperty = ownProperty(response, 'body');
  const status = statusEvidenceProperty(
    statusProperty, 'response.status', secrets
  );
  const body = stringEvidenceProperty(bodyProperty, 'response.body', secrets);
  return {
    ...(status === undefined ? {} : { status }),
    ...(body === undefined ? {} : { body })
  };
}

function project(
  value: unknown,
  secrets: readonly string[],
  includeStack: boolean,
  ancestors: WeakSet<object>,
  refineEvidence: (
    value: object,
    evidence: ErrorEvidence
  ) => ErrorEvidence | undefined
): ErrorEvidence {
  if (typeof value !== 'object' || value === null) {
    return primitiveEvidence(value, secrets);
  }
  if (isProxy(value)) {
    return unreadable('error', 'is an unreadable Proxy object');
  }
  if (ancestors.has(value)) {
    return Object.freeze({
      type: 'CircularErrorReference',
      message: 'circular error reference detected'
    });
  }
  ancestors.add(value);
  try {
    const typeProperty = ownProperty(value, 'type');
    const nameProperty = inheritedProperty(value, 'name');
    const messageProperty = inheritedProperty(value, 'message');
    const codeProperty = ownProperty(value, 'code');
    const statusProperty = ownProperty(value, 'status');
    const bodyProperty = ownProperty(value, 'body');
    const causeProperty = ownProperty(value, 'cause');
    const errorsProperty = ownProperty(value, 'errors');
    const responseProperty = ownProperty(value, 'response');

    const rawType = propertyIsUnreadable(typeProperty)
      ? 'UnreadableErrorType'
      : typeof typeProperty.value === 'string'
        ? redactEvidenceText(typeProperty.value, secrets)
        : propertyIsUnreadable(nameProperty)
          ? 'UnreadableErrorType'
          : typeof nameProperty.value === 'string'
            ? redactEvidenceText(nameProperty.value, secrets)
            : nameProperty.kind === 'data'
              && (typeof nameProperty.value === 'object'
                || typeof nameProperty.value === 'function')
              ? 'UnreadableErrorType'
              : errorsProperty.kind !== 'absent'
                ? 'AggregateError'
                : 'Error';
    const type = requiredEvidenceText(
      rawType, 'error type is empty', secrets
    );
    const rawMessage = propertyIsUnreadable(messageProperty)
      ? 'message accessor is unreadable'
      : typeof messageProperty.value === 'string'
        ? messageProperty.value
        : messageProperty.kind === 'data'
          ? typeof messageProperty.value === 'object'
            || typeof messageProperty.value === 'function'
            ? 'message value is unreadable without coercion'
            : diagnosticValue(messageProperty.value)
        : diagnosticValue(value);
    const message = requiredEvidenceText(
      rawMessage, 'error message is empty', secrets
    );
    const code = stringEvidenceProperty(codeProperty, 'code', secrets);
    const stack = stackEvidenceProperty(
      value, includeStack, nameProperty, messageProperty, secrets
    );
    const directStatus = statusEvidenceProperty(
      statusProperty, 'status', secrets
    );
    const directBody = stringEvidenceProperty(bodyProperty, 'body', secrets);
    const response = propertyIsUnreadable(responseProperty)
      ? {
          status: evidenceMarker('response.status is unreadable', secrets),
          body: evidenceMarker('response.body is unreadable', secrets)
        }
      : responseProperty.kind === 'data'
        ? responseEvidence(responseProperty.value, secrets)
        : {};
    const status = directStatus ?? response.status;
    const body = directBody ?? response.body;

    const cause = causeProperty.kind === 'accessor'
      ? unreadable('cause', 'accessor is unreadable')
      : causeProperty.kind === 'data'
        ? project(
            causeProperty.value,
            secrets,
            includeStack,
            ancestors,
            refineEvidence
          )
        : undefined;

    let errors: readonly ErrorEvidence[] | undefined;
    if (errorsProperty.kind === 'accessor') {
      errors = Object.freeze([unreadable('errors', 'accessor is unreadable')]);
    } else if (errorsProperty.kind === 'data') {
      const values = arrayValues(errorsProperty.value);
      errors = values === undefined
        ? Object.freeze([unreadable('errors', 'is an unreadable array')])
        : Object.freeze(values.map((item) => (
          project(item, secrets, includeStack, ancestors, refineEvidence)
        )));
    }

    const evidence = Object.freeze({
      type,
      message,
      ...(code === undefined ? {} : { code }),
      ...(stack === undefined ? {} : { stack }),
      ...(status === undefined ? {} : { status }),
      ...(body === undefined ? {} : { body }),
      ...(cause === undefined ? {} : { cause }),
      ...(errors === undefined ? {} : { errors })
    });
    return refineEvidence(value, evidence) ?? evidence;
  } finally {
    ancestors.delete(value);
  }
}

export function errorEvidence(
  error: unknown,
  secrets: readonly string[] = [],
  includeStack = true,
  refineEvidence: (
    value: object,
    evidence: ErrorEvidence
  ) => ErrorEvidence | undefined = () => undefined
): ErrorEvidence {
  return project(
    error,
    normalizedSecrets(secrets),
    includeStack,
    new WeakSet(),
    refineEvidence
  );
}
