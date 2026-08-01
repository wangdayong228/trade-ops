import { resolve } from 'node:path';
import {
  config,
  type DotenvConfigOptions,
  type DotenvConfigOutput
} from 'dotenv';

export interface LoadEnvironmentFileOptions {
  readonly path?: string;
  readonly processEnv?: NodeJS.ProcessEnv;
  readonly load?: (options: DotenvConfigOptions) => DotenvConfigOutput;
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }
  const descriptor = Object.getOwnPropertyDescriptor(error, 'code');
  return typeof descriptor?.value === 'string'
    ? descriptor.value
    : undefined;
}

export function loadEnvironmentFile(
  options: LoadEnvironmentFileOptions = {}
): 'loaded' | 'missing' {
  const result = (options.load ?? config)({
    path: options.path ?? resolve(process.cwd(), '.env'),
    processEnv: options.processEnv ?? process.env,
    override: false,
    quiet: true
  });
  if (result.error === undefined) {
    return 'loaded';
  }
  if (errorCode(result.error) === 'ENOENT') {
    return 'missing';
  }
  throw result.error;
}
