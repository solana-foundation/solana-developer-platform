function dumpFile<TName extends string>(name: TName): `${TName}.json` {
  return `${name}.json`;
}

export const LIGHTSPARK_EXCHANGE_RATE_SOURCES = [
  "USD",
  "EUR",
  "GBP",
  "USDC",
  "USDT",
  "SOL",
  "BTC",
] as const;

export type LightsparkExchangeRateSource = (typeof LIGHTSPARK_EXCHANGE_RATE_SOURCES)[number];

export function lightsparkExchangeRatesDumpName(source: LightsparkExchangeRateSource) {
  return `lightspark/exchange-rates-${source}` as const;
}

export const RAMP_RAIL_DUMPS = {
  moonpay: {
    currencies: {
      name: "moonpay/currencies",
      file: dumpFile("moonpay/currencies"),
    },
    countries: {
      name: "moonpay/countries",
      file: dumpFile("moonpay/countries"),
    },
  },
  lightspark: {
    config: {
      name: "lightspark/config",
      file: dumpFile("lightspark/config"),
    },
  },
  bvnk: {
    cryptoSandboxAnon: {
      name: "bvnk/crypto__sandbox-anon",
      file: dumpFile("bvnk/crypto__sandbox-anon"),
    },
    fiatSandboxAnon: {
      name: "bvnk/fiat__sandbox-anon",
      file: dumpFile("bvnk/fiat__sandbox-anon"),
    },
    depositSandboxAnon: {
      name: "bvnk/deposit__sandbox-anon",
      file: dumpFile("bvnk/deposit__sandbox-anon"),
    },
  },
} as const;
