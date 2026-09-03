import {
  COUNTERPARTY_INDUSTRY_SECTORS,
  COUNTERPARTY_INTENDED_USE,
  COUNTERPARTY_PEP_STATUSES,
  COUNTERPARTY_SOURCE_OF_FUNDS,
  COUNTERPARTY_YEARLY_INCOME,
  type Counterparty,
  type CountryCode,
  isCountryCode,
} from "@sdp/types";
import { RAMP_FIAT_CURRENCIES } from "@sdp/types/generated/ramp";
import type {
  CollectedFieldData,
  CounterpartyRequirements,
  RequirementField,
} from "@sdp/types/ramp-requirements";
import { badRequest, unsupportedCounterparty } from "../../../errors";
import {
  countryField,
  dateField,
  enumOptions,
  parseCollectedFields,
  readyCounterparty,
  selectField,
  textField,
} from "../../requirements";
import type { ValidateCounterpartyOptions } from "../../types";
import {
  type BvnkCustomerV2Individual,
  bvnkV2CddSchema,
  type CreateBvnkContactV3Input,
} from "./client";
import {
  isBvnkWalletActive,
  latestBvnkOfframpBeneficiary,
  readBvnkOfframpWallet,
} from "./provider-data";

const BVNK_EMPLOYMENT_STATUSES = ["SELF_EMPLOYED", "SALARIED", "UNEMPLOYED", "RETIRED"] as const;
const BVNK_EU_COUNTRIES = new Set<CountryCode>([
  "AT",
  "BE",
  "BG",
  "CY",
  "CZ",
  "DE",
  "DK",
  "EE",
  "ES",
  "FI",
  "FR",
  "GR",
  "HR",
  "HU",
  "IE",
  "IT",
  "LT",
  "LU",
  "LV",
  "MT",
  "NL",
  "PL",
  "PT",
  "RO",
  "SE",
  "SI",
  "SK",
]);

const BVNK_ONRAMP_BASE_FIELDS: RequirementField[] = [
  textField({
    key: "firstName",
    label: "First name",
    required: true,
    maxLength: 100,
  }),
  textField({
    key: "lastName",
    label: "Last name",
    required: true,
    maxLength: 100,
  }),
  dateField({
    key: "dateOfBirth",
    label: "Date of birth",
    required: true,
    before: new Date().toISOString().slice(0, 10),
  }),
  textField({
    key: "email",
    label: "Email",
    required: true,
    maxLength: 320,
    pattern: "^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$",
    placeholder: "name@example.com",
  }),
  {
    kind: "address",
    key: "address",
    label: "Residential address",
    required: true,
    fields: [
      textField({ key: "address.addressLine1", label: "Address line 1", required: true }),
      textField({ key: "address.city", label: "City", required: true }),
      textField({ key: "address.postalCode", label: "Postal code", required: true }),
      countryField({ key: "address.countryCode", label: "Country", required: true }),
    ],
  },
  countryField({
    key: "taxIdentification.taxResidenceCountryCode",
    label: "Tax residence country",
    required: true,
  }),
  countryField({
    key: "birthCountryCode",
    label: "Country of birth",
    required: true,
  }),
  selectField({
    key: "cdd.employmentStatus",
    label: "Employment status",
    required: true,
    options: enumOptions(BVNK_EMPLOYMENT_STATUSES),
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
  selectField({
    key: "cdd.expectedMonthlyVolume.currency",
    label: "Expected monthly volume currency",
    required: true,
    options: enumOptions(RAMP_FIAT_CURRENCIES),
  }),
];

const BVNK_ONRAMP_US_FIELDS: RequirementField[] = [
  textField({
    key: "taxIdentification.number",
    label: "Tax identification number (SSN / ITIN)",
    required: true,
    maxLength: 64,
    placeholder: "123-45-6789",
    mask: "###-##-####",
  }),
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
  textField({
    key: "address.stateCode",
    label: "State",
    required: true,
    pattern: "^([A-Za-z]{2}-)?[A-Za-z0-9]{2}$",
    placeholder: "CA",
  }),
];

const BVNK_ONRAMP_EU_FIELDS: RequirementField[] = [
  countryField({
    key: "nationality",
    label: "Nationality",
    required: true,
  }),
];

/**
 * @param countryCode - The counterparty's residence country, collected just-in-time.
 * @returns The BVNK collect fields for that residence country.
 */
export function bvnkOnrampFields(countryCode?: CountryCode): RequirementField[] {
  if (countryCode === undefined) {
    return [...BVNK_ONRAMP_BASE_FIELDS];
  }
  if (countryCode === "US") {
    return [...BVNK_ONRAMP_BASE_FIELDS, ...BVNK_ONRAMP_US_FIELDS];
  }
  return BVNK_EU_COUNTRIES.has(countryCode)
    ? [...BVNK_ONRAMP_BASE_FIELDS, ...BVNK_ONRAMP_EU_FIELDS]
    : [...BVNK_ONRAMP_BASE_FIELDS];
}

function collectedString(data: Record<string, unknown>, key: string): string {
  const value = data[key];
  if (typeof value !== "string" || value.length === 0) {
    throw badRequest(`Missing required BVNK field "${key}".`);
  }
  return value;
}

/**
 * Builds the BVNK v2 individual request from transient collected fields.
 *
 * @param collectedData - Flattened PII fields supplied for this request.
 * @returns A typed BVNK individual request. No collected value is persisted.
 */
export function buildBvnkCustomerRequest(
  collectedData: CollectedFieldData
): BvnkCustomerV2Individual {
  const base = parseCollectedFields(
    BVNK_ONRAMP_BASE_FIELDS,
    collectedData,
    "Missing or invalid BVNK customer details."
  );
  const residenceCountryValue = collectedString(base, "taxIdentification.taxResidenceCountryCode");
  if (!isCountryCode(residenceCountryValue)) {
    throw badRequest("taxIdentification.taxResidenceCountryCode must be a supported country code.");
  }
  const residenceCountry = residenceCountryValue;
  const fields = bvnkOnrampFields(residenceCountry);
  const data = parseCollectedFields(
    fields,
    collectedData,
    "Missing or invalid BVNK customer details."
  );
  const cdd = bvnkV2CddSchema.parse({
    employmentStatus: collectedString(data, "cdd.employmentStatus"),
    sourceOfFunds: collectedString(data, "cdd.sourceOfFunds"),
    pepStatus: collectedString(data, "cdd.pepStatus"),
    intendedUseOfAccount: collectedString(data, "cdd.intendedUseOfAccount"),
    expectedMonthlyVolume: {
      amount: collectedString(data, "cdd.expectedMonthlyVolume.amount"),
      currency: collectedString(data, "cdd.expectedMonthlyVolume.currency"),
    },
    ...(residenceCountry === "US"
      ? {
          estimatedYearlyIncome: collectedString(data, "cdd.estimatedYearlyIncome"),
          employmentIndustrySector: collectedString(data, "cdd.employmentIndustrySector"),
        }
      : {}),
  });
  const address = {
    addressLine1: collectedString(data, "address.addressLine1"),
    city: collectedString(data, "address.city"),
    postalCode: collectedString(data, "address.postalCode"),
    countryCode: collectedString(data, "address.countryCode"),
    ...(residenceCountry === "US" ? { stateCode: collectedString(data, "address.stateCode") } : {}),
  };
  return {
    address,
    dateOfBirth: collectedString(data, "dateOfBirth"),
    firstName: collectedString(data, "firstName"),
    lastName: collectedString(data, "lastName"),
    birthCountryCode: collectedString(data, "birthCountryCode"),
    emailAddress: collectedString(data, "email"),
    ...(BVNK_EU_COUNTRIES.has(residenceCountry)
      ? { nationality: collectedString(data, "nationality") }
      : {}),
    ...(residenceCountry === "US"
      ? {
          taxIdentification: {
            number: collectedString(data, "taxIdentification.number"),
            taxResidenceCountryCode: residenceCountry,
          },
        }
      : {}),
    cdd,
  };
}

/**
 * Builds the BVNK v3 travel-rule contact request from the same transient PII.
 *
 * @param collectedData - Flattened PII fields supplied for this request.
 * @returns A typed BVNK contact request. No collected value is persisted.
 */
export function buildBvnkContactRequest(
  collectedData: CollectedFieldData
): CreateBvnkContactV3Input["entity"] {
  const customer = buildBvnkCustomerRequest(collectedData);
  return {
    type: "INDIVIDUAL",
    relationshipType: "SELF_OWNED",
    firstName: customer.firstName,
    lastName: customer.lastName,
    dateOfBirth: customer.dateOfBirth,
    address: {
      addressLine1: customer.address.addressLine1,
      city: customer.address.city,
      postalCode: customer.address.postalCode,
      country: customer.address.countryCode,
      ...(customer.address.stateCode === undefined ? {} : { region: customer.address.stateCode }),
    },
  };
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
 * inputs — no HTTP. BVNK customer status is refreshed by the API handlers.
 */
export function validateBvnkCounterparty(
  counterparty: Counterparty,
  options: ValidateCounterpartyOptions
): CounterpartyRequirements {
  const { direction, providerData, fiatCurrency } = options;
  const collectedResidence = options.collectedData?.["taxIdentification.taxResidenceCountryCode"];
  const collectedCountry =
    collectedResidence !== undefined && isCountryCode(collectedResidence)
      ? collectedResidence
      : undefined;

  if (options.direction === "offramp") {
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
    if (options.providerCustomerReference === undefined) {
      return {
        provider: "bvnk",
        direction,
        status: "collect_counterparty",
        fields: bvnkOnrampFields(collectedCountry),
      };
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
      return {
        provider: "bvnk",
        direction,
        status: "customer_funding_account_provisioning",
      };
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
  return {
    provider: "bvnk",
    direction,
    status: "collect_counterparty",
    fields: bvnkOnrampFields(collectedCountry),
  };
}
