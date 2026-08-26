import type { Counterparty, CounterpartyIndividualIdentity, CountryCode } from "@sdp/types";
import {
  COUNTERPARTY_EMPLOYMENT_STATUSES,
  COUNTERPARTY_INDUSTRY_SECTORS,
  COUNTERPARTY_INTENDED_USE,
  COUNTERPARTY_PEP_STATUSES,
  COUNTERPARTY_SOURCE_OF_FUNDS,
  COUNTERPARTY_YEARLY_INCOME,
  COUNTRIES,
} from "@sdp/types";
import type {
  CollectedFieldData,
  CounterpartyRequirements,
  RequirementField,
} from "@sdp/types/ramp-requirements";
import { z } from "zod";
import type { CounterpartyRow } from "../../../counterparty";
import { badRequest, SdpPaymentsError, unsupportedCounterparty } from "../../../errors";
import {
  addressFields,
  buildRequirementSchema,
  enumOptions,
  parseCollectedAddress,
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
];

export function bvnkOnrampFields(country: CountryCode): BvnkOnrampField[] {
  const fields: BvnkOnrampField[] = [
    ...addressFields(country).map((descriptor) => ({ descriptor, read: () => undefined })),
    ...BVNK_ONRAMP_BASE_FIELDS,
  ];
  return country === "US" ? [...fields, ...BVNK_ONRAMP_US_FIELDS] : fields;
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
  expectedVolumeCurrency: string,
  country: CountryCode
): Record<string, unknown> {
  if (counterparty.entity_type !== "individual") {
    throw badRequest("BVNK on-ramp requires an individual counterparty.");
  }
  const identity = counterparty.identity;
  const fields = bvnkOnrampFields(country);
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

  const collectedAddress = parseCollectedAddress(
    country,
    collectedData,
    "Missing or invalid address details required for BVNK on-ramp."
  );
  const address: Record<string, string> = {
    addressLine1: collectedAddress.line1,
    city: collectedAddress.city,
    postalCode: collectedAddress.postalCode,
    countryCode: country,
  };
  if (collectedAddress.line2 !== undefined) {
    address.addressLine2 = collectedAddress.line2;
  }
  if (collectedAddress.subdivisionCode !== undefined) {
    address.stateCode = normalizeBvnkStateCode(country, collectedAddress.subdivisionCode);
  }

  return {
    description: "SDP onramp",
    firstName: identity.firstName,
    lastName: identity.lastName,
    dateOfBirth: identity.dateOfBirth,
    emailAddress: counterparty.email,
    nationality: resolveField("nationality"),
    birthCountryCode: resolveField("birthCountryCode"),
    taxIdentification: {
      number: resolveField("taxIdentification.number").replace(/\D/g, ""),
      taxResidenceCountryCode: resolveField("taxIdentification.taxResidenceCountryCode"),
    },
    address,
    cdd: {
      employmentStatus: resolveField("cdd.employmentStatus"),
      sourceOfFunds: resolveField("cdd.sourceOfFunds"),
      pepStatus: resolveField("cdd.pepStatus"),
      intendedUseOfAccount: resolveField("cdd.intendedUseOfAccount"),
      expectedMonthlyVolume: {
        amount: resolveField("cdd.expectedMonthlyVolume.amount"),
        currency: expectedVolumeCurrency,
      },
      ...(country === "US"
        ? {
            estimatedYearlyIncome: resolveField("cdd.estimatedYearlyIncome"),
            employmentIndustrySector: resolveField("cdd.employmentIndustrySector"),
          }
        : {}),
    },
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
    country,
    providerData,
    collectedData,
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
  const identity = counterparty.identity;

  const customer = readBvnkCustomer(providerData);
  if (customer.customerReference) {
    const configuredStatus = onrampConfiguredStatus();
    if (configuredStatus.status !== "funding_account_provisioning") {
      return configuredStatus;
    }
    const fields = addressFields(country);
    const suppliedAddress = buildRequirementSchema(fields).safeParse(collectedData);
    if (suppliedAddress.success) {
      return configuredStatus;
    }
    return { provider: "bvnk", direction, status: "collect", fields: [...fields] };
  }

  const missing = bvnkOnrampFields(country)
    .filter((field) => field.read(identity) === undefined)
    .map((field) => field.descriptor);
  if (missing.length === 0) {
    return onrampConfiguredStatus();
  }
  return { provider: "bvnk", direction, status: "collect", fields: missing };
}
