import {
  OFFRAMP_COUNTRY_RAILS,
  OFFRAMP_PAYOUT_ACCOUNTS,
  OFFRAMP_SUPPORT,
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
const COUNTRY_RAILS: Partial<
  Record<RampProviderId, Readonly<Partial<Record<string, readonly string[]>>>>
> = OFFRAMP_COUNTRY_RAILS;

export interface OfframpDestinationResolution {
  /** Provider account type the payout external account must be created as. */
  accountType: string;
  /** Rails deliverable for this corridor and destination, each with the fields it requires. */
  rails: Record<string, Readonly<Record<string, RampPayoutFieldSpec>>>;
}

/**
 * Answers the off-ramp destination question in one lookup: given a corridor
 * (crypto rail to fiat currency) and a destination country, which rails can
 * the provider pay out over, and which account fields does each rail need.
 *
 * Resolution order: the corridor must exist in the generated pair matrix for
 * the provider; the destination country must accept the fiat currency per the
 * provider's country support (providers with unreported coverage are not
 * gated on country); the rails are the country's rails intersected with the
 * provider's payout-account rails for the currency.
 *
 * @param input - Provider, corridor, and destination to resolve.
 * @returns Rails and per-rail field requirements, or null when the corridor
 * cannot deliver to the destination or the provider reports no account specs.
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
  switch (countrySupport.coverage) {
    case "by-country": {
      const countryCurrencies = countrySupport.countries[input.countryCode];
      if (countryCurrencies === undefined || !countryCurrencies.includes(input.fiatCurrency)) {
        return null;
      }
      break;
    }
    case "all-currencies": {
      if (!countrySupport.countries.includes(input.countryCode)) {
        return null;
      }
      break;
    }
    case "unreported":
      break;
  }

  const account = PAYOUT_ACCOUNTS[input.provider]?.[input.fiatCurrency];
  if (account === undefined) {
    return null;
  }

  const countryRails = COUNTRY_RAILS[input.provider]?.[input.countryCode];
  const rails: OfframpDestinationResolution["rails"] = {};
  for (const [rail, fields] of Object.entries(account.rails)) {
    if (countryRails === undefined || countryRails.includes(rail)) {
      rails[rail] = fields;
    }
  }
  if (Object.keys(rails).length === 0) {
    return null;
  }
  return { accountType: account.accountType, rails };
}
