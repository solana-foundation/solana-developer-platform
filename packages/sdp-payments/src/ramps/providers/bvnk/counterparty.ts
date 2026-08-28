import type { Counterparty, CountryCode } from "@sdp/types";
import {
  COUNTERPARTY_EMPLOYMENT_STATUSES,
  COUNTERPARTY_INDUSTRY_SECTORS,
  COUNTERPARTY_INTENDED_USE,
  COUNTERPARTY_PEP_STATUSES,
  COUNTERPARTY_SOURCE_OF_FUNDS,
  COUNTERPARTY_YEARLY_INCOME,
  COUNTRIES,
  US_STATES,
} from "@sdp/types";
import type { CounterpartyRequirements, RequirementField } from "@sdp/types/ramp-requirements";
import { badRequest, unsupportedCounterparty } from "../../../errors";
import { enumOptions, readyCounterparty, selectField, textField } from "../../requirements";
import type { ValidateCounterpartyOptions } from "../../types";
import {
  bvnkOnrampStatusFromProviderData,
  isBvnkWalletActive,
  latestBvnkOfframpBeneficiary,
  readBvnkCustomer,
  readBvnkOfframpWallet,
} from "./provider-data";

const COUNTRY_OPTIONS = COUNTRIES.map((country) => ({ value: country.code, label: country.name }));
const US_STATE_OPTIONS = US_STATES.map((state) => ({ value: state.code, label: state.name }));

const BVNK_ONRAMP_BASE_FIELDS: RequirementField[] = [
  // TODO: US-centric SSN/ITIN mask + format; branch per-country for non-US tax IDs.
  textField({
    key: "taxIdentification.number",
    label: "Tax identification number (SSN / ITIN)",
    required: true,
    maxLength: 64,
    placeholder: "123-45-6789",
    mask: "###-##-####",
  }),
  selectField({
    key: "taxIdentification.taxResidenceCountryCode",
    label: "Tax residence country",
    required: true,
    options: COUNTRY_OPTIONS,
  }),
  selectField({
    key: "nationality",
    label: "Nationality",
    required: true,
    options: COUNTRY_OPTIONS,
  }),
  selectField({
    key: "birthCountryCode",
    label: "Country of birth",
    required: true,
    options: COUNTRY_OPTIONS,
  }),
  selectField({
    key: "cdd.employmentStatus",
    label: "Employment status",
    required: true,
    options: enumOptions(COUNTERPARTY_EMPLOYMENT_STATUSES),
  }),
  selectField({
    key: "cdd.sourceOfFunds",
    label: "Source of funds",
    required: true,
    options: enumOptions(COUNTERPARTY_SOURCE_OF_FUNDS),
  }),
  selectField({
    key: "cdd.pepStatus",
    label: "Politically exposed person status",
    required: true,
    options: enumOptions(COUNTERPARTY_PEP_STATUSES),
  }),
  selectField({
    key: "cdd.intendedUseOfAccount",
    label: "Intended use of account",
    required: true,
    options: enumOptions(COUNTERPARTY_INTENDED_USE),
  }),
  textField({
    key: "cdd.expectedMonthlyVolume.amount",
    label: "Expected monthly volume",
    required: true,
    pattern: "^\\d+(\\.\\d{1,2})?$",
    placeholder: "1000",
  }),
];

const BVNK_ONRAMP_US_FIELDS: RequirementField[] = [
  selectField({
    key: "cdd.estimatedYearlyIncome",
    label: "Estimated yearly income",
    required: true,
    options: enumOptions(COUNTERPARTY_YEARLY_INCOME),
  }),
  selectField({
    key: "cdd.employmentIndustrySector",
    label: "Employment industry sector",
    required: true,
    options: enumOptions(COUNTERPARTY_INDUSTRY_SECTORS),
  }),
  selectField({
    key: "address.stateCode",
    label: "State",
    required: true,
    options: US_STATE_OPTIONS,
  }),
];

/**
 * @param countryCode - The counterparty's residence country, collected just-in-time.
 * @returns The BVNK onramp requirement fields for that country (US adds income, industry, and state).
 */
export function bvnkOnrampFields(countryCode: CountryCode): RequirementField[] {
  return countryCode === "US"
    ? [...BVNK_ONRAMP_BASE_FIELDS, ...BVNK_ONRAMP_US_FIELDS]
    : BVNK_ONRAMP_BASE_FIELDS;
}

interface BvnkOfframpSpec {
  accountType: string;
  fields: readonly RequirementField[];
}

// Add corridors here as BVNK payout support is verified; each fiat maps to a bank-detail field set.
const BVNK_OFFRAMP_SPECS = {
  USD: {
    accountType: "ACH",
    fields: [
      textField({
        key: "accountNumber",
        label: "Account number",
        required: true,
        pattern: "^[0-9]{4,17}$",
      }),
      textField({
        key: "routingNumber",
        label: "Routing number",
        required: true,
        pattern: "^[0-9]{9}$",
        placeholder: "021000021",
      }),
    ],
  },
  EUR: {
    accountType: "SEPA_CT",
    fields: [
      textField({
        key: "iban",
        label: "IBAN",
        required: true,
        pattern: "^[A-Z]{2}[0-9A-Z]{13,32}$",
        placeholder: "DE89370400440532013000",
      }),
    ],
  },
} as const satisfies Record<string, BvnkOfframpSpec>;

export type BvnkOfframpCurrency = keyof typeof BVNK_OFFRAMP_SPECS;

export function isBvnkOfframpCurrency(value: string): value is BvnkOfframpCurrency {
  return Object.hasOwn(BVNK_OFFRAMP_SPECS, value);
}

export function bvnkOfframpAccountType(fiatCurrency: BvnkOfframpCurrency): string {
  return BVNK_OFFRAMP_SPECS[fiatCurrency].accountType;
}

export function bvnkOfframpFields(fiatCurrency: BvnkOfframpCurrency): RequirementField[] {
  return [...BVNK_OFFRAMP_SPECS[fiatCurrency].fields];
}

/**
 * Decides what BVNK still needs from a counterparty before a ramp can run.
 * Pure decision over stored `provider_data` plus the caller-resolved ramp
 * inputs — no HTTP. On-ramp customer verification/status resolution is
 * delegated to {@link bvnkOnrampStatusFromProviderData} once a BVNK customer
 * exists, so the phase switch lives in exactly one place.
 */
export function validateBvnkCounterparty(
  counterparty: Counterparty,
  {
    direction,
    providerData,
    cryptoToken,
    fiatCurrency,
    destinationWalletAddress,
  }: ValidateCounterpartyOptions
): CounterpartyRequirements {
  const onrampConfiguredStatus = (): CounterpartyRequirements => {
    if (!cryptoToken) {
      throw badRequest("cryptoToken is required for BVNK on-ramp requirements.");
    }
    if (!fiatCurrency) {
      throw badRequest("fiatCurrency is required for BVNK on-ramp requirements.");
    }
    if (!destinationWalletAddress) {
      throw badRequest("destinationWallet is required for BVNK on-ramp requirements.");
    }
    return bvnkOnrampStatusFromProviderData(providerData, {
      cryptoToken,
      fiatCurrency,
      destinationWalletAddress,
    });
  };

  if (direction === "offramp") {
    if (!fiatCurrency) {
      throw badRequest("fiatCurrency is required for BVNK off-ramp requirements.");
    }
    if (!isBvnkOfframpCurrency(fiatCurrency)) {
      return unsupportedCounterparty(
        "bvnk",
        direction,
        `BVNK off-ramp does not support payouts in ${fiatCurrency}.`
      );
    }
    if (!latestBvnkOfframpBeneficiary(providerData, fiatCurrency)) {
      return {
        provider: "bvnk",
        direction,
        status: "collect",
        fields: bvnkOfframpFields(fiatCurrency),
      };
    }
    const wallet = readBvnkOfframpWallet(providerData, fiatCurrency);
    if (!wallet || !isBvnkWalletActive(wallet.status)) {
      return { provider: "bvnk", direction, status: "funding_account_provisioning" };
    }
    return readyCounterparty("bvnk", direction);
  }

  if (counterparty.entityType !== "individual") {
    return unsupportedCounterparty(
      "bvnk",
      direction,
      "BVNK on-ramp supports individual counterparties only."
    );
  }
  const customer = readBvnkCustomer(providerData);
  if (customer.customerReference) {
    return onrampConfiguredStatus();
  }

  throw badRequest(
    "BVNK onramp requires identity fields that are no longer stored; JIT collection is not wired yet"
  );
}
