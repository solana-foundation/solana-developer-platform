import {
  OFFRAMP_PAYOUT_ACCOUNTS,
  OFFRAMP_SUPPORT,
  OFFRAMP_SWIFT_SUPPORT,
  RAMP_PROVIDER_SUPPORT_DETAILS,
} from "./generated/ramp.generated";
import type {
  CryptoRailId,
  OfframpPairSupport,
  RampCountrySupport,
  RampPayoutAccountSpec,
  RampPayoutFieldSpec,
} from "./payment-rails";
import type { RampProviderId } from "./provider-access";

const OFFRAMP_PAIRS: readonly OfframpPairSupport[] = OFFRAMP_SUPPORT;
const PAYOUT_ACCOUNTS: Partial<
  Record<RampProviderId, Readonly<Record<string, RampPayoutAccountSpec>>>
> = OFFRAMP_PAYOUT_ACCOUNTS;
const SWIFT_SUPPORT: Partial<
  Record<RampProviderId, { account: RampPayoutAccountSpec; excludedCountries: readonly string[] }>
> = OFFRAMP_SWIFT_SUPPORT;

export interface OfframpRailResolution {
  /** Provider account type the payout external account must be created as. */
  accountType: string;
  /** Fields the account needs for this rail, with provider-declared validation. */
  fields: Readonly<Record<string, RampPayoutFieldSpec>>;
}

export interface OfframpDestinationResolution {
  /** Rails deliverable for this corridor and destination. */
  rails: Record<string, OfframpRailResolution>;
}

/**
 * Answers the off-ramp destination question in one lookup: given a corridor
 * (crypto rail to fiat currency) and a destination country, which rails can
 * the provider pay out over, and which account fields does each rail need.
 *
 * Local rails come from the provider's payout account for the currency, gated
 * on the destination country accepting that currency. SWIFT is the default
 * rail for every covered country (minus the provider's SWIFT exclusions) and
 * delivers any corridor currency, so it stays available when no local rail
 * matches — e.g. USD into MY.
 *
 * @param input - Provider, corridor, and destination to resolve.
 * @returns Rails with per-rail account type and fields, or null when the
 * corridor cannot deliver to the destination at all.
 */
export function resolveOfframpDestination(input: {
  provider: RampProviderId;
  cryptoRail: CryptoRailId;
  fiatCurrency: string;
  countryCode: string;
}): OfframpDestinationResolution | null {
  const corridor = OFFRAMP_PAIRS.find(
    (row) => row.source === input.cryptoRail && row.dest === input.fiatCurrency
  );
  if (corridor === undefined || !corridor.providers.includes(input.provider)) {
    return null;
  }

  const countrySupport: RampCountrySupport =
    RAMP_PROVIDER_SUPPORT_DETAILS[input.provider].offramp.countrySupport;
  const rails: OfframpDestinationResolution["rails"] = {};

  const localAllowed = countryAcceptsCurrency(
    countrySupport,
    input.countryCode,
    input.fiatCurrency
  );
  const account = PAYOUT_ACCOUNTS[input.provider]?.[input.fiatCurrency];
  if (localAllowed && account !== undefined) {
    for (const [rail, fields] of Object.entries(account.rails)) {
      rails[rail] = { accountType: account.accountType, fields };
    }
  }

  const swift = SWIFT_SUPPORT[input.provider];
  if (
    swift !== undefined &&
    countrySupport.coverage === "by-country" &&
    countrySupport.countries[input.countryCode] !== undefined &&
    !swift.excludedCountries.includes(input.countryCode)
  ) {
    const fields = swift.account.rails.SWIFT;
    if (fields === undefined) {
      throw new Error(`${input.provider} SWIFT account spec is missing its SWIFT rail.`);
    }
    rails.SWIFT = { accountType: swift.account.accountType, fields };
  }

  if (Object.keys(rails).length === 0) {
    return null;
  }
  return { rails };
}

/**
 * Whether the provider's country support allows delivering the currency to
 * the country over local rails. Unreported coverage does not gate.
 *
 * @param countrySupport - Provider off-ramp country support.
 * @param countryCode - Destination country.
 * @param fiatCurrency - Currency to deliver.
 * @returns True when local delivery is allowed.
 */
function countryAcceptsCurrency(
  countrySupport: RampCountrySupport,
  countryCode: string,
  fiatCurrency: string
): boolean {
  switch (countrySupport.coverage) {
    case "by-country": {
      const countryCurrencies = countrySupport.countries[countryCode];
      return countryCurrencies !== undefined && countryCurrencies.includes(fiatCurrency);
    }
    case "all-currencies":
      return countrySupport.countries.includes(countryCode);
    case "unreported":
      return true;
  }
}
