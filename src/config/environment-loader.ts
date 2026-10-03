import { resolve } from 'node:path';
import { isProxy } from 'node:util/types';
import {
  config,
  type DotenvConfigOptions,
  type DotenvConfigOutput
} from 'dotenv';
import {
  createTradeOpsError,
  safeFailureCategory
} from '../errors/trade-ops-error.js';

export interface LoadEnvironmentFileOptions {
  readonly path?: string;
  readonly processEnv?: NodeJS.ProcessEnv;
  readonly load?: (options: DotenvConfigOptions) => DotenvConfigOutput;
}

function errorCode(error: unknown): string | undefined {
  if (
    typeof error !== 'object'
    || error === null
    || isProxy(error)
  ) {
    return undefined;
  }
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(error, 'code');
  } catch {
    return undefined;
  }
  return typeof descriptor?.value === 'string'
    ? descriptor.value
    : undefined;
}

function environmentLoadFailure(error: unknown): never {
  throw createTradeOpsError({
    code: 'CONFIG_FIELD_INVALID',
    phase: 'startup',
    subject: { type: 'configuration', field: 'environment-file' },
    expected: 'readable environment file or missing file',
    actual: safeFailureCategory(error)
  });
}

export function loadEnvironmentFile(
  options: LoadEnvironmentFileOptions = {}
): 'loaded' | 'missing' {
  let result: DotenvConfigOutput;
  try {
    result = (options.load ?? config)({
      path: options.path ?? resolve(process.cwd(), '.env'),
      processEnv: options.processEnv ?? process.env,
      override: false,
      quiet: true
    });
  } catch (error) {
    return environmentLoadFailure(error);
  }
  if (
    typeof result !== 'object'
    || result === null
    || isProxy(result)
  ) {
    return environmentLoadFailure(result);
  }
  let errorDescriptor: PropertyDescriptor | undefined;
  try {
    errorDescriptor = Object.getOwnPropertyDescriptor(result, 'error');
  } catch (error) {
    return environmentLoadFailure(error);
  }
  if (errorDescriptor === undefined) {
    return 'loaded';
  }
  if (!('value' in errorDescriptor)) {
    return environmentLoadFailure(result);
  }
  const loadError = errorDescriptor.value as unknown;
  if (loadError === undefined) {
    return 'loaded';
  }
  if (errorCode(loadError) === 'ENOENT') {
    return 'missing';
  }
  return environmentLoadFailure(loadError);
}
