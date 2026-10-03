/// <reference types="node" />

import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type {
  DotenvConfigOptions,
  DotenvConfigOutput
} from 'dotenv';
import {
  loadEnvironmentFile
} from '../../src/config/environment-loader.js';
import {
  withErrorPhase,
  type ErrorDetail,
  type TradeOpsError
} from '../../src/errors/trade-ops-error.js';

function startupDetail(error: unknown): ErrorDetail {
  return withErrorPhase(error as TradeOpsError, 'startup').detail;
}

function assertEnvironmentFailure(
  action: () => unknown,
  actual: string,
  forbidden: readonly string[] = []
): void {
  assert.throws(action, (error: unknown) => {
    const detail = startupDetail(error);
    assert.equal(detail.code, 'CONFIG_FIELD_INVALID');
    assert.equal(detail.phase, 'startup');
    assert.equal(detail.subject.type, 'configuration');
    assert.equal(typeof detail.subject.field, 'string');
    assert.notEqual(detail.subject.field.length, 0);
    assert.equal(detail.actual, actual);
    assert.equal(typeof detail.expected, 'string');
    const serialized = JSON.stringify(detail);
    for (const value of forbidden) assert.doesNotMatch(serialized, new RegExp(value));
    assert.doesNotMatch(serialized, /stack|cause/);
    return true;
  });
}

test('loads .env without overriding an existing variable', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'trade-ops-env-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, '.env');
  await writeFile(path, 'PORT=4000\nTRADING_EXCHANGES=bitget,okx\n');
  const processEnv: NodeJS.ProcessEnv = { PORT: '3000' };

  assert.equal(loadEnvironmentFile({ path, processEnv }), 'loaded');
  assert.equal(processEnv.PORT, '3000');
  assert.equal(processEnv.TRADING_EXCHANGES, 'bitget,okx');
});

test('treats only ENOENT as an optional missing file', () => {
  const output = (code: string): DotenvConfigOutput => ({
    error: Object.assign(new Error(code), { code })
  }) as unknown as DotenvConfigOutput;

  assert.equal(
    loadEnvironmentFile({ load: () => output('ENOENT') }),
    'missing'
  );
  assertEnvironmentFailure(
    () => loadEnvironmentFile({ load: () => output('EACCES') }),
    'object-failure',
    ['EACCES']
  );
});

test('converts thrown dotenv failures without retaining raw values', () => {
  assertEnvironmentFailure(
    () => loadEnvironmentFile({
      load: () => { throw 'dotenv-string-secret'; }
    }),
    'string-thrown',
    ['dotenv-string-secret']
  );
  assertEnvironmentFailure(
    () => loadEnvironmentFile({
      load: () => {
        throw {
          message: 'dotenv-object-secret',
          cause: new Error('dotenv-cause-secret'),
          credential: 'dotenv-property-secret'
        };
      }
    }),
    'object-failure',
    [
      'dotenv-object-secret',
      'dotenv-cause-secret',
      'dotenv-property-secret'
    ]
  );
});

test('converts hostile returned dotenv failures without invoking traps or getters', () => {
  let descriptorTrapReads = 0;
  const proxiedError = new Proxy(new Error('dotenv-proxy-secret'), {
    getOwnPropertyDescriptor(): never {
      descriptorTrapReads += 1;
      throw new Error('dotenv-descriptor-secret');
    }
  });
  assertEnvironmentFailure(
    () => loadEnvironmentFile({
      load: () => ({ error: proxiedError }) as DotenvConfigOutput
    }),
    'object-failure',
    ['dotenv-proxy-secret', 'dotenv-descriptor-secret']
  );
  assert.equal(descriptorTrapReads, 0);

  const revoked = Proxy.revocable(new Error('dotenv-revoked-secret'), {});
  revoked.revoke();
  assertEnvironmentFailure(
    () => loadEnvironmentFile({
      load: () => ({ error: revoked.proxy }) as DotenvConfigOutput
    }),
    'object-failure',
    ['dotenv-revoked-secret']
  );

  let codeGetterReads = 0;
  const accessorError = new Error('dotenv-accessor-secret');
  Object.defineProperty(accessorError, 'code', {
    configurable: true,
    enumerable: true,
    get(): string {
      codeGetterReads += 1;
      return 'ENOENT';
    }
  });
  assertEnvironmentFailure(
    () => loadEnvironmentFile({
      load: () => ({ error: accessorError }) as DotenvConfigOutput
    }),
    'object-failure',
    ['dotenv-accessor-secret']
  );
  assert.equal(codeGetterReads, 0);

  let resultErrorGetterReads = 0;
  const accessorResult = {} as DotenvConfigOutput;
  Object.defineProperty(accessorResult, 'error', {
    configurable: true,
    enumerable: true,
    get(): Error {
      resultErrorGetterReads += 1;
      throw new Error('dotenv-result-getter-secret');
    }
  });
  assertEnvironmentFailure(
    () => loadEnvironmentFile({ load: () => accessorResult }),
    'object-failure',
    ['dotenv-result-getter-secret']
  );
  assert.equal(resultErrorGetterReads, 0);
});

test('loads dotenv quietly and preserves the target environment', () => {
  const processEnv: NodeJS.ProcessEnv = {};
  let received: DotenvConfigOptions | undefined;
  const load = (options: DotenvConfigOptions): DotenvConfigOutput => {
    received = options;
    return { parsed: {} };
  };

  assert.equal(loadEnvironmentFile({ processEnv, load }), 'loaded');
  assert.equal(received?.processEnv, processEnv);
  assert.equal(received?.override, false);
  assert.equal(received?.quiet, true);
});
