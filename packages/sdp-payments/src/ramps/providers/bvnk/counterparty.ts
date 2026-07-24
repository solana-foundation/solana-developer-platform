import type { Counterparty, CounterpartyIndividualIdentity } from "@sdp/types";
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
import type {
  CollectedFieldData,
  CounterpartyRequirements,
  RampDirection,
  RequirementField,
} from "@sdp/types/ramp-requirements";
import { z } from "zod";
import type { CounterpartyRow } from "../../../counterparty";
import { badRequest, SdpPaymentsError, unsupportedCounterparty } from "../../../errors";
import {
  buildRequirementSchema,
  enumOptions,
  ISO_DATE_PATTERN,
  readyCounterparty,
  selectField,
  textField,
} from "../../requirements";
import type { ValidateCounterpartyOptions } from "../../types";
import {
  bvnkOnrampStatusFromProviderData,
  isBvnkWalletActive,
  latestBvnkOfframpBeneficiary,
  normalizeBvnkStateCode,
  readBvnkCustomer,
  readBvnkOfframpWallet,
} from "./provider-data";

interface BvnkOnrampField {
  descriptor: RequirementField;
  read: (identity: CounterpartyIndividualIdentity) => string | undefined;
}

const COUNTRY_OPTIONS = COUNTRIES.map((country) => ({ value: country.code, label: country.name }));
const US_STATE_OPTIONS = US_STATES.map((state) => ({ value: state.code, label: state.name }));

const BVNK_COMPANY_ENTITY_TYPES = [
  "CORPORATION",
  "LIMITED_LIABILITY_COMPANY",
  "PARTNERSHIP",
  "TRUST",
] as const;
const BVNK_COMPANY_MONTHLY_EXPECTED_VOLUMES = [
  "FROM_100K_TO_1M",
  "FROM_1M_TO_10M",
  "ABOVE_10M",
] as const;
const BVNK_COMPANY_SOURCES_OF_FUNDS = [
  "COMMERCIAL_ACTIVITIES",
  "SHAREHOLDER_CAPITAL",
  "SALE_OF_ASSETS",
] as const;
const BVNK_COMPANY_INTENDED_USES = ["SUPPLIER_VENDOR_PAYMENTS", "PAYROLL"] as const;

const BVNK_COMPANY_ONRAMP_FIELDS: RequirementField[] = [
  selectField({
    key: "company.entityType",
    label: "Company entity type",
    required: true,
    options: enumOptions(BVNK_COMPANY_ENTITY_TYPES),
  }),
  textField({
    key: "company.registrationNumber",
    label: "Company registration number",
    required: true,
  }),
  textField({
    key: "company.taxIdentification.number",
    label: "Company tax identification number",
    required: true,
  }),
  selectField({
    key: "company.taxIdentification.taxResidenceCountryCode",
    label: "Company tax residence country",
    required: true,
    options: COUNTRY_OPTIONS,
  }),
  textField({
    key: "company.incorporationDate",
    label: "Company incorporation date",
    required: true,
    pattern: ISO_DATE_PATTERN,
    placeholder: "2019-01-15",
  }),
  textField({
    key: "company.businessOperationsStartDate",
    label: "Business operations start date",
    required: true,
    pattern: ISO_DATE_PATTERN,
    placeholder: "2019-01-15",
  }),
  textField({
    key: "company.businessProfile.naicsCode",
    label: "NAICS code",
    required: true,
    pattern: "^\\d{2,6}$",
    placeholder: "5239",
  }),
  textField({
    key: "company.businessProfile.website",
    label: "Company website",
    required: true,
    pattern: "^https?://.+",
  }),
  selectField({
    key: "company.businessProfile.monthlyExpectedVolumes",
    label: "Expected monthly volume",
    required: true,
    options: enumOptions(BVNK_COMPANY_MONTHLY_EXPECTED_VOLUMES),
  }),
  selectField({
    key: "company.businessProfile.sourceOfFunds",
    label: "Source of funds",
    required: true,
    options: enumOptions(BVNK_COMPANY_SOURCES_OF_FUNDS),
  }),
  selectField({
    key: "company.businessProfile.intendedUseOfAccount",
    label: "Intended use of account",
    required: true,
    options: enumOptions(BVNK_COMPANY_INTENDED_USES),
  }),
  selectField({
    key: "company.businessProfile.isRegulated",
    label: "Is the company regulated?",
    required: true,
    options: [
      { value: "true", label: "Yes" },
      { value: "false", label: "No" },
    ],
  }),
  textField({ key: "associate.firstName", label: "Associate first name", required: true }),
  textField({ key: "associate.lastName", label: "Associate last name", required: true }),
  textField({
    key: "associate.dateOfBirth",
    label: "Associate date of birth",
    required: true,
    pattern: ISO_DATE_PATTERN,
    placeholder: "1982-03-24",
  }),
  selectField({
    key: "associate.nationality",
    label: "Associate nationality",
    required: true,
    options: COUNTRY_OPTIONS,
  }),
  selectField({
    key: "associate.birthCountryCode",
    label: "Associate country of birth",
    required: true,
    options: COUNTRY_OPTIONS,
  }),
  textField({
    key: "associate.emailAddress",
    label: "Associate email address",
    required: true,
  }),
  textField({
    key: "associate.taxIdentification.number",
    label: "Associate tax identification number",
    required: true,
  }),
  selectField({
    key: "associate.taxIdentification.taxResidenceCountryCode",
    label: "Associate tax residence country",
    required: true,
    options: COUNTRY_OPTIONS,
  }),
  textField({
    key: "associate.ownership.percentage",
    label: "Associate ownership percentage",
    required: true,
    pattern: "^(100|[1-9]?\\d)$",
    placeholder: "100",
  }),
];

const BVNK_COMPANY_SCHEMA = buildRequirementSchema(BVNK_COMPANY_ONRAMP_FIELDS);

/**
 * Builds the unsupported-counterparty requirements naming stored identity
 * fields a BVNK on-ramp needs but the counterparty lacks, or null when all
 * labelled values are present.
 *
 * @param direction Ramp direction the requirements decision is for.
 * @param fields Human-readable label to stored identity value.
 * @returns Unsupported requirements listing the missing labels, or null.
 */
function missingBvnkIdentityRequirements(
  direction: RampDirection,
  fields: Record<string, string | undefined>
): CounterpartyRequirements | null {
  const missing = Object.entries(fields)
    .filter(([, value]) => !value)
    .map(([label]) => label);
  if (missing.length === 0) {
    return null;
  }
  return unsupportedCounterparty(
    "bvnk",
    direction,
    `Counterparty is missing details required for BVNK on-ramp: ${missing.join(", ")}.`
  );
}

const BVNK_ONRAMP_BASE_FIELDS: BvnkOnrampField[] = [
  {
    // TODO: US-centric SSN/ITIN mask + format; branch per-country for non-US tax IDs.
    descriptor: textField({
      key: "taxIdentification.number",
      label: "Tax identification number (SSN / ITIN)",
      required: true,
      maxLength: 64,
      placeholder: "123-45-6789",
      mask: "###-##-####",
    }),
    read: () => undefined,
  },
  {
    descriptor: selectField({
      key: "taxIdentification.taxResidenceCountryCode",
      label: "Tax residence country",
      required: true,
      options: COUNTRY_OPTIONS,
    }),
    read: () => undefined,
  },
  {
    descriptor: selectField({
      key: "nationality",
      label: "Nationality",
      required: true,
      options: COUNTRY_OPTIONS,
    }),
    read: () => undefined,
  },
  {
    descriptor: selectField({
      key: "birthCountryCode",
      label: "Country of birth",
      required: true,
      options: COUNTRY_OPTIONS,
    }),
    read: () => undefined,
  },
  {
    descriptor: selectField({
      key: "cdd.employmentStatus",
      label: "Employment status",
      required: true,
      options: enumOptions(COUNTERPARTY_EMPLOYMENT_STATUSES),
    }),
    read: () => undefined,
  },
  {
    descriptor: selectField({
      key: "cdd.sourceOfFunds",
      label: "Source of funds",
      required: true,
      options: enumOptions(COUNTERPARTY_SOURCE_OF_FUNDS),
    }),
    read: () => undefined,
  },
  {
    descriptor: selectField({
      key: "cdd.pepStatus",
      label: "Politically exposed person status",
      required: true,
      options: enumOptions(COUNTERPARTY_PEP_STATUSES),
    }),
    read: () => undefined,
  },
  {
    descriptor: selectField({
      key: "cdd.intendedUseOfAccount",
      label: "Intended use of account",
      required: true,
      options: enumOptions(COUNTERPARTY_INTENDED_USE),
    }),
    read: () => undefined,
  },
  {
    descriptor: textField({
      key: "cdd.expectedMonthlyVolume.amount",
      label: "Expected monthly volume",
      required: true,
      pattern: "^\\d+(\\.\\d{1,2})?$",
      placeholder: "1000",
    }),
    read: () => undefined,
  },
];

const BVNK_ONRAMP_US_FIELDS: BvnkOnrampField[] = [
  {
    descriptor: selectField({
      key: "cdd.estimatedYearlyIncome",
      label: "Estimated yearly income",
      required: true,
      options: enumOptions(COUNTERPARTY_YEARLY_INCOME),
    }),
    read: () => undefined,
  },
  {
    descriptor: selectField({
      key: "cdd.employmentIndustrySector",
      label: "Employment industry sector",
      required: true,
      options: enumOptions(COUNTERPARTY_INDUSTRY_SECTORS),
    }),
    read: () => undefined,
  },
  {
    descriptor: selectField({
      key: "address.stateCode",
      label: "State",
      required: true,
      options: US_STATE_OPTIONS,
    }),
    read: (id) => id.address?.subdivisionCode,
  },
];

export function bvnkOnrampFields(identity: CounterpartyIndividualIdentity): BvnkOnrampField[] {
  return identity.address?.countryCode === "US"
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

export function buildBvnkIndividualPayload(
  counterparty: CounterpartyRow,
  collectedData: CollectedFieldData | undefined,
  expectedVolumeCurrency: string
): Record<string, unknown> {
  if (counterparty.entity_type !== "individual") {
    throw badRequest("BVNK on-ramp requires an individual counterparty.");
  }
  const identity = counterparty.identity;
  const fields = bvnkOnrampFields(identity);
  const missing = fields.filter((field) => field.read(identity) === undefined);

  let supplied: Record<string, unknown> = {};
  if (missing.length > 0) {
    const result = buildRequirementSchema(missing.map((field) => field.descriptor)).safeParse(
      collectedData
    );
    if (!result.success) {
      throw new SdpPaymentsError(
        "BAD_REQUEST",
        "Missing or invalid KYC details required for BVNK on-ramp.",
        { errors: z.treeifyError(result.error) }
      );
    }
    supplied = result.data;
  }

  const resolveField = (key: string): string => {
    const field = fields.find((entry) => entry.descriptor.key === key);
    if (!field) {
      throw new Error(`Unknown BVNK on-ramp field "${key}"`);
    }
    const stored = field.read(identity);
    if (stored !== undefined) {
      return stored;
    }
    const collected = supplied[key];
    if (typeof collected !== "string") {
      throw badRequest(`Missing required field "${key}" for BVNK on-ramp.`);
    }
    return collected;
  };

  const address = identity.address;
  const isUnitedStates = address?.countryCode === "US";

  return {
    description: "SDP onramp",
    firstName: identity.firstName,
    lastName: identity.lastName,
    ...(identity.dateOfBirth ? { dateOfBirth: identity.dateOfBirth } : {}),
    emailAddress: counterparty.email,
    nationality: resolveField("nationality"),
    birthCountryCode: resolveField("birthCountryCode"),
    taxIdentification: {
      number: resolveField("taxIdentification.number").replace(/\D/g, ""),
      taxResidenceCountryCode: resolveField("taxIdentification.taxResidenceCountryCode"),
    },
    ...(address
      ? {
          address: {
            addressLine1: address.line1,
            ...(address.line2 ? { addressLine2: address.line2 } : {}),
            city: address.city,
            ...(address.postalCode ? { postalCode: address.postalCode } : {}),
            countryCode: address.countryCode,
            ...(isUnitedStates
              ? {
                  stateCode: normalizeBvnkStateCode(
                    address.countryCode,
                    resolveField("address.stateCode")
                  ),
                }
              : {}),
          },
        }
      : {}),
    cdd: {
      employmentStatus: resolveField("cdd.employmentStatus"),
      sourceOfFunds: resolveField("cdd.sourceOfFunds"),
      pepStatus: resolveField("cdd.pepStatus"),
      intendedUseOfAccount: resolveField("cdd.intendedUseOfAccount"),
      expectedMonthlyVolume: {
        amount: resolveField("cdd.expectedMonthlyVolume.amount"),
        currency: expectedVolumeCurrency,
      },
      ...(isUnitedStates
        ? {
            estimatedYearlyIncome: resolveField("cdd.estimatedYearlyIncome"),
            employmentIndustrySector: resolveField("cdd.employmentIndustrySector"),
          }
        : {}),
    },
  };
}

/** Builds BVNK's v2 company customer payload from stored identity and transient JIT fields. */
export function buildBvnkCompanyPayload(
  counterparty: CounterpartyRow,
  collectedData: CollectedFieldData | undefined
): Record<string, unknown> {
  if (counterparty.entity_type !== "business") {
    throw badRequest("BVNK company on-ramp requires a business counterparty.");
  }
  const result = BVNK_COMPANY_SCHEMA.safeParse(collectedData);
  if (!result.success) {
    throw new SdpPaymentsError(
      "BAD_REQUEST",
      "Missing or invalid company details required for BVNK on-ramp.",
      { errors: z.treeifyError(result.error) }
    );
  }
  const readCollected = (key: string): string => {
    const value = result.data[key];
    if (typeof value !== "string") {
      throw badRequest(`Missing required field "${key}" for BVNK company on-ramp.`);
    }
    return value;
  };
  const address = counterparty.identity.address;
  const companyAddress = {
    addressLine1: address.line1,
    ...(address.line2 ? { addressLine2: address.line2 } : {}),
    city: address.city,
    ...(address.postalCode ? { postalCode: address.postalCode } : {}),
    countryCode: address.countryCode,
  };

  return {
    name: counterparty.display_name,
    entityType: readCollected("company.entityType"),
    taxIdentification: {
      number: readCollected("company.taxIdentification.number"),
      taxResidenceCountryCode: readCollected("company.taxIdentification.taxResidenceCountryCode"),
    },
    registrationNumber: readCollected("company.registrationNumber"),
    incorporationDate: readCollected("company.incorporationDate"),
    businessOperationsStartDate: readCollected("company.businessOperationsStartDate"),
    address: companyAddress,
    isOperationalAddressDifferent: false,
    businessProfile: {
      naicsCode: readCollected("company.businessProfile.naicsCode"),
      website: readCollected("company.businessProfile.website"),
      monthlyExpectedVolumes: readCollected("company.businessProfile.monthlyExpectedVolumes"),
      intendedUseOfAccount: readCollected("company.businessProfile.intendedUseOfAccount"),
      isRegulated: readCollected("company.businessProfile.isRegulated") === "true",
      sourceOfFunds: readCollected("company.businessProfile.sourceOfFunds"),
    },
    associates: [
      {
        person: {
          firstName: readCollected("associate.firstName"),
          lastName: readCollected("associate.lastName"),
          dateOfBirth: readCollected("associate.dateOfBirth"),
          nationality: readCollected("associate.nationality"),
          birthCountryCode: readCollected("associate.birthCountryCode"),
          address: companyAddress,
          contactInfo: { emailAddress: readCollected("associate.emailAddress") },
          taxIdentification: {
            number: readCollected("associate.taxIdentification.number"),
            taxResidenceCountryCode: readCollected(
              "associate.taxIdentification.taxResidenceCountryCode"
            ),
          },
        },
        titles: ["UBO", "DIRECTOR", "SIGNATORY", "ACCOUNT_REPRESENTATIVE"],
        ownership: {
          percentage: readCollected("associate.ownership.percentage"),
          type: "DIRECT",
        },
      },
    ],
  };
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

  const identity = counterparty.identity;

  if (!identity.address.countryCode) {
    return unsupportedCounterparty(
      "bvnk",
      direction,
      "Counterparty is missing a stored address country, required for BVNK on-ramp."
    );
  }

  const customer = readBvnkCustomer(providerData);
  if (customer.customerReference) {
    return onrampConfiguredStatus();
  }

  if (counterparty.entityType === "business") {
    const missingIdentity = missingBvnkIdentityRequirements(direction, {
      "display name": counterparty.displayName,
      "address line 1": identity.address.line1,
      "address city": identity.address.city,
    });
    if (missingIdentity) {
      return missingIdentity;
    }
    return {
      provider: "bvnk",
      direction,
      status: "collect",
      fields: BVNK_COMPANY_ONRAMP_FIELDS,
    };
  }

  const individualIdentity = counterparty.identity;
  const missingIdentity = missingBvnkIdentityRequirements(direction, {
    "first name": individualIdentity.firstName,
    "last name": individualIdentity.lastName,
    "date of birth": individualIdentity.dateOfBirth,
    "address line 1": individualIdentity.address.line1,
    "address city": individualIdentity.address.city,
  });
  if (missingIdentity) {
    return missingIdentity;
  }

  const missing = bvnkOnrampFields(individualIdentity)
    .filter((field) => field.read(individualIdentity) === undefined)
    .map((field) => field.descriptor);
  if (missing.length === 0) {
    return onrampConfiguredStatus();
  }
  return { provider: "bvnk", direction, status: "collect", fields: missing };
}
