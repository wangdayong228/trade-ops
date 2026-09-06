import { bitget, okx } from 'ccxt';
import { BitgetFundingRateSource } from './bitget-funding-rate-source.js';
import { OkxFundingRateSource } from './okx-funding-rate-source.js';

interface PublicCcxtClientOptions {
  readonly enableRateLimit: true;
  readonly timeout: 15_000;
}

interface CcxtFundingRateSourceConstructors {
  readonly bitget: new (
    options: PublicCcxtClientOptions
  ) => ConstructorParameters<typeof BitgetFundingRateSource>[0];
  readonly okx: new (
    options: PublicCcxtClientOptions
  ) => ConstructorParameters<typeof OkxFundingRateSource>[0];
}

const PRODUCTION_CONSTRUCTORS: CcxtFundingRateSourceConstructors = {
  bitget,
  okx
};

function publicClientOptions(): PublicCcxtClientOptions {
  return {
    enableRateLimit: true,
    timeout: 15_000
  };
}

export function createCcxtFundingRateSources(
  constructors: CcxtFundingRateSourceConstructors = PRODUCTION_CONSTRUCTORS
): readonly [BitgetFundingRateSource, OkxFundingRateSource] {
  const bitgetSource = new BitgetFundingRateSource(
    new constructors.bitget(publicClientOptions())
  );
  const okxSource = new OkxFundingRateSource(
    new constructors.okx(publicClientOptions())
  );
  return [bitgetSource, okxSource];
}
