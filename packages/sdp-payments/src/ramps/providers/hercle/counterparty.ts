import type { Counterparty } from "@sdp/types/counterparties";
import type { CounterpartyRequirements, RequirementField } from "@sdp/types/ramp-requirements";
import type { ValidateCounterpartyOptions } from "../../types";
import { hercleOnboardingRequirements, readHercleData } from "./provider-data";

/**
 * Hercle onboards regulated business customers in its CH/EEA perimeter. The registered
 * address is KYB input Hercle must hold, but SDP no longer stores counterparty PII, so it
 * is collected at provisioning time and passed straight through — never persisted here.
 */
const HERCLE_JURISDICTION_BY_COUNTRY = {
  CH: "SWISS",
  AT: "EU",
  BE: "EU",
  BG: "EU",
  CY: "EU",
  CZ: "EU",
  DE: "EU",
  DK: "EU",
  EE: "EU",
  ES: "EU",
  FI: "EU",
  FR: "EU",
  GR: "EU",
  HR: "EU",
  HU: "EU",
  IE: "EU",
  IS: "EU",
  IT: "EU",
  LI: "EU",
  LT: "EU",
  LU: "EU",
  LV: "EU",
  MT: "EU",
  NL: "EU",
  NO: "EU",
  PL: "EU",
  PT: "EU",
  RO: "EU",
  SE: "EU",
  SI: "EU",
  SK: "EU",
} as const satisfies Record<string, "SWISS" | "EU">;

const HERCLE_COUNTRY_LABELS: Record<keyof typeof HERCLE_JURISDICTION_BY_COUNTRY, string> = {
  CH: "Switzerland",
  AT: "Austria",
  BE: "Belgium",
  BG: "Bulgaria",
  CY: "Cyprus",
  CZ: "Czechia",
  DE: "Germany",
  DK: "Denmark",
  EE: "Estonia",
  ES: "Spain",
  FI: "Finland",
  FR: "France",
  GR: "Greece",
  HR: "Croatia",
  HU: "Hungary",
  IE: "Ireland",
  IS: "Iceland",
  IT: "Italy",
  LI: "Liechtenstein",
  LT: "Lithuania",
  LU: "Luxembourg",
  LV: "Latvia",
  MT: "Malta",
  NL: "Netherlands",
  NO: "Norway",
  PL: "Poland",
  PT: "Portugal",
  RO: "Romania",
  SE: "Sweden",
  SI: "Slovenia",
  SK: "Slovakia",
};

export type HercleJurisdiction = "SWISS" | "EU";

/** CH → SWISS, EEA → EU, anything else → unsupported (returns undefined). */
export function hercleJurisdictionForCountry(countryCode: string): HercleJurisdiction | undefined {
  return HERCLE_JURISDICTION_BY_COUNTRY[countryCode as keyof typeof HERCLE_JURISDICTION_BY_COUNTRY];
}

export const HERCLE_REGISTRATION_NUMBER_FIELD_KEY = "registrationNumber";
export const HERCLE_REGISTRATION_COUNTRY_FIELD_KEY = "registrationCountry";
export const HERCLE_ADDRESS_LINE1_FIELD_KEY = "registeredAddressLine1";
export const HERCLE_ADDRESS_CITY_FIELD_KEY = "registeredAddressCity";
export const HERCLE_ADDRESS_POSTAL_CODE_FIELD_KEY = "registeredAddressPostalCode";

/**
 * KYB inputs Hercle requires to open the sub-account. The country doubles as the
 * jurisdiction discriminator, so it is a closed list of the CH/EEA perimeter rather than a
 * free-text field — an out-of-perimeter business simply cannot be selected.
 */
export function hercleOnboardingFields(): RequirementField[] {
  return [
    {
      kind: "text",
      key: HERCLE_REGISTRATION_NUMBER_FIELD_KEY,
      label: "Company registration number",
      required: true,
      minLength: 2,
      maxLength: 64,
      placeholder: "CHE-123.456.789",
    },
    {
      kind: "select",
      key: HERCLE_REGISTRATION_COUNTRY_FIELD_KEY,
      label: "Country of registration",
      required: true,
      options: Object.keys(HERCLE_JURISDICTION_BY_COUNTRY).map((code) => ({
        value: code,
        label: HERCLE_COUNTRY_LABELS[code as keyof typeof HERCLE_COUNTRY_LABELS],
      })),
    },
    {
      kind: "text",
      key: HERCLE_ADDRESS_LINE1_FIELD_KEY,
      label: "Registered address",
      required: true,
      minLength: 2,
      maxLength: 128,
      placeholder: "Bahnhofstrasse 1",
    },
    {
      kind: "text",
      key: HERCLE_ADDRESS_CITY_FIELD_KEY,
      label: "City",
      required: true,
      minLength: 1,
      maxLength: 64,
      placeholder: "Zurich",
    },
    {
      kind: "text",
      key: HERCLE_ADDRESS_POSTAL_CODE_FIELD_KEY,
      label: "Postal code",
      required: true,
      minLength: 2,
      maxLength: 16,
      placeholder: "8001",
    },
  ];
}

export function hercleCounterpartyRequirements(
  counterparty: Counterparty,
  options: ValidateCounterpartyOptions
): CounterpartyRequirements {
  const { direction, providerData } = options;

  if (counterparty.entityType !== "business") {
    return {
      provider: "hercle",
      direction,
      status: "unsupported",
      reason: "Hercle supports business counterparties only.",
    };
  }

  const data = readHercleData(providerData);
  if (!data.accountId) {
    return {
      provider: "hercle",
      direction,
      status: "collect",
      fields: hercleOnboardingFields(),
    };
  }

  return hercleOnboardingRequirements(data, direction);
}
