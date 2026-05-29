function dumpFile<TName extends string>(name: TName): `${TName}.json` {
  return `${name}.json`;
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
    cryptoAnon: {
      name: "bvnk/crypto__anon",
      file: dumpFile("bvnk/crypto__anon"),
    },
    fiatAnon: {
      name: "bvnk/fiat__anon",
      file: dumpFile("bvnk/fiat__anon"),
    },
    depositAnon: {
      name: "bvnk/deposit__anon",
      file: dumpFile("bvnk/deposit__anon"),
    },
  },
} as const;
