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
  assert.throws(
    () => loadEnvironmentFile({ load: () => output('EACCES') }),
    /^Error: EACCES$/
  );
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
