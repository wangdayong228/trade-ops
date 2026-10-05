/// <reference types="node" />

import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';

const ERROR_EVIDENCE_MODULE_SPECIFIER = '../../src/errors/error-evidence.js';

interface ErrorEvidence {
  readonly type: string;
  readonly message: string;
  readonly code?: string;
  readonly stack?: string;
  readonly status?: string | number;
  readonly body?: string;
  readonly cause?: ErrorEvidence;
  readonly errors?: readonly ErrorEvidence[];
}

interface ErrorEvidenceModule {
  readonly errorEvidence: (
    error: unknown,
    secrets?: readonly string[],
    includeStack?: boolean
  ) => ErrorEvidence;
  readonly redactEvidenceText: (
    value: string,
    secrets?: readonly string[]
  ) => string;
  readonly diagnosticValue: (value: unknown) => string;
}

async function loadEvidenceModule(): Promise<ErrorEvidenceModule> {
  let loaded: unknown;
  try {
    loaded = await import(ERROR_EVIDENCE_MODULE_SPECIFIER);
  } catch {
    assert.fail(
      '缺少安全错误证据投影能力：src/errors/error-evidence.ts 尚不可加载'
    );
  }

  assert.equal(typeof loaded, 'object');
  assert.notEqual(loaded, null);
  const candidate = loaded as Partial<ErrorEvidenceModule>;
  for (const exportName of [
    'errorEvidence',
    'redactEvidenceText',
    'diagnosticValue'
  ] as const) {
    assert.equal(
      typeof candidate[exportName],
      'function',
      `缺少安全错误证据投影导出：${exportName}`
    );
  }
  return candidate as ErrorEvidenceModule;
}

function codedError(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

test('projects distinct native failures with nested causes and stacks', async () => {
  const { errorEvidence } = await loadEvidenceModule();
  const permission = codedError('EACCES: open /synthetic/config', 'EACCES');
  const disk = codedError('ENOSPC: write /synthetic/config', 'ENOSPC');
  const permissionEvidence = errorEvidence(
    new Error('environment load failed', { cause: permission })
  );
  const diskEvidence = errorEvidence(
    new Error('environment load failed', { cause: disk })
  );

  assert.equal(permissionEvidence.cause?.code, 'EACCES');
  assert.match(permissionEvidence.cause?.message ?? '', /EACCES/u);
  assert.match(permissionEvidence.cause?.stack ?? '', /EACCES/u);
  assert.equal(diskEvidence.cause?.code, 'ENOSPC');
  assert.match(diskEvidence.cause?.message ?? '', /ENOSPC/u);
  assert.notDeepEqual(permissionEvidence, diskEvidence);
});

test('projects aggregate members, non-Error values, and circular causes', async () => {
  const { errorEvidence } = await loadEvidenceModule();
  const aggregate = new AggregateError([
    codedError('permission rejected', 'EACCES'),
    'synthetic string failure',
    42
  ], 'cleanup produced multiple failures');
  const aggregateEvidence = errorEvidence(aggregate);

  assert.equal(aggregateEvidence.errors?.length, 3);
  assert.match(JSON.stringify(aggregateEvidence.errors), /EACCES/u);
  assert.match(JSON.stringify(aggregateEvidence.errors), /synthetic string failure/u);
  assert.match(JSON.stringify(aggregateEvidence.errors), /42/u);

  const first = new Error('first failure');
  const second = new Error('second failure');
  Object.defineProperty(first, 'cause', { value: second });
  Object.defineProperty(second, 'cause', { value: first });
  const circularEvidence = errorEvidence(first);
  const rendered = JSON.stringify(circularEvidence);
  assert.match(rendered, /first failure/u);
  assert.match(rendered, /second failure/u);
  assert.match(rendered, /circular|cycle|循环/iu);
});

test('keeps long message tails and external response status and body', async () => {
  const { errorEvidence } = await loadEvidenceModule();
  const messageTail = 'terminal-message-evidence';
  const bodyTail = 'terminal-response-evidence';
  const error = Object.assign(
    new Error(`${'x'.repeat(9_000)}${messageTail}`),
    {
      response: {
        status: 429,
        body: `${'y'.repeat(9_000)}${bodyTail}`
      }
    }
  );

  const evidence = errorEvidence(error);

  assert.equal(evidence.message.endsWith(messageTail), true);
  assert.equal(evidence.status, 429);
  assert.equal(evidence.body?.endsWith(bodyTail), true);
});

test('redacts configured secrets, sensitive body keys, headers, and private keys', async () => {
  const { errorEvidence } = await loadEvidenceModule();
  const configuredSecret = 'configured-fake-secret';
  const authorization = 'Bearer synthetic-header-token';
  const privateKey = '-----BEGIN PRIVATE KEY-----synthetic-key-material-----END PRIVATE KEY-----';
  const queryApiKey = 'synthetic-query-api-key';
  const querySignature = 'synthetic-query-signature';
  const error = Object.assign(
    new Error(
      `GET https://synthetic.invalid/orders?apiKey=${queryApiKey}`
      + `&signature=${querySignature} failed: `
      + '{"code":"40101","msg":"synthetic account denied",'
      + '"secret":"synthetic-message-secret"} '
      + configuredSecret
    ),
    {
      code: 'AUTH_FAILED',
      headers: { authorization },
      response: {
        status: 401,
        body: JSON.stringify({
          message: 'synthetic request denied',
          apiKey: 'synthetic-body-api-key',
          authorization,
          privateKey
        })
      }
    }
  );

  const rendered = JSON.stringify(errorEvidence(error, [configuredSecret]));

  assert.match(rendered, /synthetic request denied/u);
  assert.match(rendered, /40101/u);
  assert.match(rendered, /synthetic account denied/u);
  for (const forbidden of [
    configuredSecret,
    authorization,
    queryApiKey,
    querySignature,
    'synthetic-message-secret',
    'synthetic-body-api-key',
    'synthetic-key-material'
  ]) {
    assert.equal(rendered.includes(forbidden), false);
  }
});

test('redacts encrypted private keys without hiding non-private certificates', async () => {
  const { redactEvidenceText } = await loadEvidenceModule();
  const privateMaterial = 'synthetic-encrypted-private-material';
  const certificateMaterial = 'synthetic-public-certificate-material';
  const rendered = redactEvidenceText(
    `-----BEGIN ENCRYPTED PRIVATE KEY-----${privateMaterial}`
    + '-----END ENCRYPTED PRIVATE KEY----- '
    + `-----BEGIN CERTIFICATE-----${certificateMaterial}`
    + '-----END CERTIFICATE-----'
  );

  assert.equal(rendered.includes(privateMaterial), false);
  assert.match(rendered, /\[Redacted\]/u);
  assert.match(rendered, new RegExp(certificateMaterial, 'u'));
});

test('redacts string status, structured JSON values, escaped and overlapping secrets', async () => {
  const { errorEvidence, redactEvidenceText } = await loadEvidenceModule();
  const escapedSecret = 'fake"secret';
  const error = Object.assign(new Error(JSON.stringify({
    message: `failure ${escapedSecret}`,
    apiKey: { first: 'fake-a', second: 'fake-b' }
  })), { status: 'fake-status' });

  const rendered = JSON.stringify(errorEvidence(error, [
    escapedSecret,
    'fake-status',
    'Redacted'
  ]));
  for (const forbidden of [
    escapedSecret,
    'fake-status',
    'fake-a',
    'fake-b',
    'Redacted'
  ]) {
    assert.equal(rendered.includes(forbidden), false);
  }
  assert.equal(
    redactEvidenceText('token=abc123&short=abc', ['abc', 'abc123']),
    'token=[Redacted]&short=[Redacted]'
  );
  const authorization = redactEvidenceText(
    'Authorization: Basic c3ludGhldGljOmZha2U='
  );
  assert.equal(authorization.includes('c3ludGhldGljOmZha2U='), false);
  const encodedKey = redactEvidenceText(
    'GET https://synthetic.invalid?a%70iKey=fake-key&code=401'
  );
  assert.equal(encodedKey.includes('fake-key'), false);
  assert.match(encodedKey, /code=401/u);
  const credentialContainer = redactEvidenceText(
    '{"credentials":{"first":"fake-a","second":"fake-b"},"code":401}'
  );
  assert.equal(credentialContainer.includes('fake-a'), false);
  assert.equal(credentialContainer.includes('fake-b'), false);
  assert.match(credentialContainer, /"code":401/u);
  const keySecretCollision = redactEvidenceText(
    '{"secret":"synthetic-unconfigured","code":401}',
    ['secret']
  );
  assert.equal(keySecretCollision.includes('synthetic-unconfigured'), false);
  assert.match(keySecretCollision, /"code":401/u);
});

test('redacts JSON-escaped sensitive keys and containers while retaining public fields', async () => {
  const { redactEvidenceText } = await loadEvidenceModule();
  const rendered = redactEvidenceText(
    String.raw`{"api\u004bey":"synthetic-credential","reason":"order rejected",`
    + String.raw`"creden\u0074ials":{"first":"fake-a","second":"fake-b"}}`
  );

  assert.equal(rendered.includes('synthetic-credential'), false);
  assert.equal(rendered.includes('fake-a'), false);
  assert.equal(rendered.includes('fake-b'), false);
  assert.match(rendered, /order rejected/u);
});

test('normalizes secret arrays without materializing an attached lazy stack', async () => {
  const { redactEvidenceText } = await loadEvidenceModule();
  const original = Object.getOwnPropertyDescriptor(Error, 'prepareStackTrace');
  const secret = 'synthetic-normalized-secret';
  const secrets = [secret];
  let calls = 0;
  Object.defineProperty(Error, 'prepareStackTrace', {
    configurable: true,
    enumerable: false,
    writable: true,
    value(): string {
      calls += 1;
      return 'synthetic secret-array stack';
    }
  });
  const custom = Object.getOwnPropertyDescriptor(Error, 'prepareStackTrace');
  try {
    Error.captureStackTrace(secrets);

    const redacted = redactEvidenceText(`failure: ${secret}`, secrets);

    assert.equal(calls, 0);
    assert.equal(redacted.includes(secret), false);
    assert.deepEqual(
      Object.getOwnPropertyDescriptor(Error, 'prepareStackTrace'),
      custom
    );
  } finally {
    if (original === undefined) {
      Reflect.deleteProperty(Error, 'prepareStackTrace');
    } else {
      Object.defineProperty(Error, 'prepareStackTrace', original);
    }
  }
});

test('preserves projected and native error types across repeated projection', async () => {
  const { errorEvidence } = await loadEvidenceModule();

  assert.equal(
    errorEvidence({ type: 'NetworkError', message: 'network failed' }).type,
    'NetworkError'
  );
  assert.equal(errorEvidence(new TypeError('wrong type')).type, 'TypeError');
});

test('does not execute getters, Proxy traps, or toJSON while marking unreadable data', async () => {
  const { errorEvidence } = await loadEvidenceModule();
  const secret = 'synthetic-hostile-secret';
  let getterCalls = 0;
  let proxyCalls = 0;
  let toJsonCalls = 0;
  const hostile = new Error('safe root failure');
  Object.defineProperty(hostile, 'cause', {
    get(): never {
      getterCalls += 1;
      throw new Error(secret);
    }
  });
  Object.defineProperty(hostile, 'toJSON', {
    value(): never {
      toJsonCalls += 1;
      throw new Error(secret);
    }
  });
  const proxied = new Proxy(new Error(secret), {
    get(): never {
      proxyCalls += 1;
      throw new Error(secret);
    },
    getOwnPropertyDescriptor(): never {
      proxyCalls += 1;
      throw new Error(secret);
    },
    getPrototypeOf(): never {
      proxyCalls += 1;
      throw new Error(secret);
    },
    ownKeys(): never {
      proxyCalls += 1;
      throw new Error(secret);
    }
  });

  const hostileEvidence = errorEvidence(hostile, [secret]);
  const proxyEvidence = errorEvidence(proxied, [secret]);
  const rendered = JSON.stringify([hostileEvidence, proxyEvidence]);

  assert.equal(getterCalls, 0);
  assert.equal(proxyCalls, 0);
  assert.equal(toJsonCalls, 0);
  assert.equal(rendered.includes(secret), false);
  assert.match(rendered, /accessor|unreadable|proxy|访问器|不可读|不可检查/iu);
});

test('does not materialize stack through hostile Error name or message accessors', async () => {
  const { errorEvidence } = await loadEvidenceModule();
  const secret = 'synthetic-lazy-stack-secret';
  for (const property of ['name', 'message'] as const) {
    let reads = 0;
    const hostile = new Error('safe initial message');
    Object.defineProperty(hostile, property, {
      get(): string {
        reads += 1;
        return secret;
      }
    });

    const rendered = JSON.stringify(errorEvidence(hostile, [secret]));

    assert.equal(reads, 0, property);
    assert.equal(rendered.includes(secret), false, property);
    assert.match(rendered, /accessor|unreadable|访问器|不可读/iu);
    if (property === 'name') {
      assert.match(rendered, /safe initial message/u);
    }
  }
});

test('does not coerce hostile Error name or message data while materializing stack', async () => {
  const { errorEvidence } = await loadEvidenceModule();
  for (const property of ['name', 'message'] as const) {
    let calls = 0;
    const hostile = new Error('retain this safe evidence');
    Object.defineProperty(hostile, property, {
      value: {
        toString(): string {
          calls += 1;
          return 'synthetic-hostile-coercion';
        }
      }
    });

    const evidence = errorEvidence(hostile);
    const rendered = JSON.stringify(evidence);

    assert.equal(calls, 0, property);
    assert.equal(rendered.includes('synthetic-hostile-coercion'), false, property);
    assert.equal('stack' in evidence, false, property);
    if (property === 'name') {
      assert.match(evidence.message, /retain this safe evidence/u);
    } else {
      assert.match(evidence.message, /unreadable|coercion|不可读/iu);
    }
  }
});

test('bypasses and restores custom stack formatters for every lazy V8 stack', async () => {
  const { errorEvidence } = await loadEvidenceModule();
  const original = Object.getOwnPropertyDescriptor(Error, 'prepareStackTrace');
  let calls = 0;
  Object.defineProperty(Error, 'prepareStackTrace', {
    configurable: true,
    enumerable: false,
    writable: true,
    value(): string {
      calls += 1;
      return 'synthetic custom stack';
    }
  });
  const custom = Object.getOwnPropertyDescriptor(Error, 'prepareStackTrace');
  try {
    const native = new Error('native lazy stack');
    const captured = { message: 'captureStackTrace holder' };
    Error.captureStackTrace(captured);

    const nativeEvidence = errorEvidence(native);
    const capturedEvidence = errorEvidence(captured);

    assert.equal(calls, 0);
    assert.match(nativeEvidence.stack ?? '', /Error: native lazy stack/u);
    assert.match(capturedEvidence.stack ?? '', /Error: captureStackTrace holder/u);
    assert.deepEqual(
      Object.getOwnPropertyDescriptor(Error, 'prepareStackTrace'),
      custom
    );
  } finally {
    if (original === undefined) {
      Reflect.deleteProperty(Error, 'prepareStackTrace');
    } else {
      Object.defineProperty(Error, 'prepareStackTrace', original);
    }
  }
});

test('does not materialize lazy stacks owned by another realm', async () => {
  const { errorEvidence } = await loadEvidenceModule();
  const context = vm.createContext({ calls: 0 });
  const foreignError = vm.runInContext(`
    Error.prepareStackTrace = () => {
      calls += 1;
      return 'synthetic foreign stack';
    };
    new Error('foreign error');
  `, context);
  const foreignHolder = vm.runInContext(`
    const holder = { message: 'foreign holder' };
    Error.captureStackTrace(holder);
    holder;
  `, context);

  const rendered = JSON.stringify([
    errorEvidence(foreignError),
    errorEvidence(foreignHolder)
  ]);

  assert.equal(context.calls, 0);
  assert.doesNotMatch(rendered, /synthetic foreign stack/u);
  assert.match(rendered, /stack.*(?:realm|unreadable)/iu);
});

test('normalizes empty required evidence fields throughout error graphs', async () => {
  const { errorEvidence } = await loadEvidenceModule();
  const unnamed = new Error('');
  Object.defineProperty(unnamed, 'name', { value: '' });
  const nested = new Error('', { cause: unnamed });
  const aggregate = new AggregateError([new Error(), nested], '');
  const evidence = errorEvidence(aggregate, [], false);
  const nodes = [
    evidence,
    ...(evidence.errors ?? []),
    evidence.errors?.[1]?.cause
  ].filter((item): item is ErrorEvidence => item !== undefined);

  for (const item of nodes) {
    assert.ok(item.type.length > 0);
    assert.ok(item.message.length > 0);
  }
});

test('marks unreadable and unsupported code and status without executing accessors', async () => {
  const { errorEvidence } = await loadEvidenceModule();
  let calls = 0;
  const direct = new Error('direct metadata failure');
  for (const property of ['code', 'status'] as const) {
    Object.defineProperty(direct, property, {
      get(): never {
        calls += 1;
        throw new Error('must not execute');
      }
    });
  }
  const response = Object.assign(new Error('response metadata failure'), {
    response: {}
  });
  Object.defineProperty(response.response, 'status', {
    get(): never {
      calls += 1;
      throw new Error('must not execute');
    }
  });
  const unsupported = Object.assign(new Error('unsupported metadata failure'), {
    code: { unsafe: true },
    status: { unsafe: true }
  });

  const projected = [
    errorEvidence(direct, [], false),
    errorEvidence(response, [], false),
    errorEvidence(unsupported, [], false)
  ];
  const rendered = JSON.stringify(projected);

  assert.equal(calls, 0);
  assert.match(String(projected[0]?.code), /code.*(?:accessor|unreadable)/iu);
  assert.match(String(projected[0]?.status), /status.*(?:accessor|unreadable)/iu);
  assert.match(String(projected[1]?.status), /status.*(?:accessor|unreadable)/iu);
  assert.match(String(projected[2]?.code), /code.*(?:unsupported|invalid)/iu);
  assert.match(String(projected[2]?.status), /status.*(?:unsupported|invalid)/iu);
  assert.doesNotMatch(rendered, /must not execute/u);
});

test('preserves optional empty strings as observed evidence', async () => {
  const { errorEvidence } = await loadEvidenceModule();
  const source = {
    type: 'Error',
    message: 'optional empty evidence',
    code: '',
    stack: '',
    status: '',
    body: ''
  };

  assert.deepEqual(errorEvidence(source), {
    type: 'Error',
    message: 'optional empty evidence',
    code: '',
    stack: '',
    status: '',
    body: ''
  });
});

test('diagnostic values distinguish primitives without executing hostile objects', async () => {
  const { diagnosticValue } = await loadEvidenceModule();
  const primitiveValues: readonly unknown[] = [
    undefined,
    null,
    false,
    0,
    17n,
    'synthetic primitive failure'
  ];
  const primitiveDiagnostics = primitiveValues.map(diagnosticValue);
  assert.equal(
    primitiveDiagnostics.every((value) => value.length > 0),
    true
  );
  assert.equal(new Set(primitiveDiagnostics).size, primitiveValues.length);

  const secret = 'synthetic-diagnostic-hostile-secret';
  let calls = 0;
  const hostile: Record<string, unknown> = {};
  Object.defineProperty(hostile, 'message', {
    get(): never {
      calls += 1;
      throw new Error(secret);
    }
  });
  Object.defineProperty(hostile, 'toJSON', {
    value(): never {
      calls += 1;
      throw new Error(secret);
    }
  });
  const proxied = new Proxy({}, {
    get(): never {
      calls += 1;
      throw new Error(secret);
    },
    getOwnPropertyDescriptor(): never {
      calls += 1;
      throw new Error(secret);
    },
    getPrototypeOf(): never {
      calls += 1;
      throw new Error(secret);
    },
    ownKeys(): never {
      calls += 1;
      throw new Error(secret);
    }
  });

  const hostileDiagnostics = [diagnosticValue(hostile), diagnosticValue(proxied)];
  assert.equal(calls, 0);
  assert.equal(hostileDiagnostics.every((value) => value.length > 0), true);
  assert.equal(JSON.stringify(hostileDiagnostics).includes(secret), false);
  assert.match(
    hostileDiagnostics.join(' '),
    /object|proxy|unreadable|对象|不可读|不可检查/iu
  );
});
