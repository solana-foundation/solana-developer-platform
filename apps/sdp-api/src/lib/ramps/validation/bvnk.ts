import type { Counterparty, CounterpartyIdentity } from "@sdp/types";
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
  RequirementField,
} from "@sdp/types/ramp-requirements";
import { z } from "zod";
import type { CounterpartyRow } from "@/db/repositories/counterparty.repository";
import { AppError, badRequest, internalError, unsupportedCounterparty } from "@/lib/errors";
import {
  bvnkUnverifiedOnboardingStatus,
  isBvnkCustomerVerified,
  isBvnkWalletActive,
  latestBvnkOfframpBeneficiary,
  readBvnkCustomer,
  readBvnkOfframpWallet,
} from "../providers/bvnk";
import {
  buildRequirementSchema,
  enumOptions,
  readyCounterparty,
  selectField,
  textField,
} from "../requirements";
import type { ValidateCounterpartyOptions } from "../types";

interface BvnkOnrampField {
  descriptor: RequirementField;
  read: (identity: CounterpartyIdentity) => string | undefined;
}

const COUNTRY_OPTIONS = COUNTRIES.map((country) => ({ value: country.code, label: country.name }));
const US_STATE_OPTIONS = US_STATES.map((state) => ({ value: state.code, label: state.name }));

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
    read: (id) => id.compliance?.taxIdentification?.number,
  },
  {
    descriptor: selectField({
      key: "taxIdentification.taxResidenceCountryCode",
      label: "Tax residence country",
      required: true,
      options: COUNTRY_OPTIONS,
    }),
    read: (id) => id.compliance?.taxIdentification?.residenceCountryCode,
  },
  {
    descriptor: selectField({
      key: "nationality",
      label: "Nationality",
      required: true,
      options: COUNTRY_OPTIONS,
    }),
    read: (id) => id.compliance?.nationality,
  },
  {
    descriptor: selectField({
      key: "birthCountryCode",
      label: "Country of birth",
      required: true,
      options: COUNTRY_OPTIONS,
    }),
    read: (id) => id.compliance?.birthCountryCode,
  },
  {
    descriptor: selectField({
      key: "cdd.employmentStatus",
      label: "Employment status",
      required: true,
      options: enumOptions(COUNTERPARTY_EMPLOYMENT_STATUSES),
    }),
    read: (id) => id.compliance?.cdd?.employmentStatus,
  },
  {
    descriptor: selectField({
      key: "cdd.sourceOfFunds",
      label: "Source of funds",
      required: true,
      options: enumOptions(COUNTERPARTY_SOURCE_OF_FUNDS),
    }),
    read: (id) => id.compliance?.cdd?.sourceOfFunds,
  },
  {
    descriptor: selectField({
      key: "cdd.pepStatus",
      label: "Politically exposed person status",
      required: true,
      options: enumOptions(COUNTERPARTY_PEP_STATUSES),
    }),
    read: (id) => id.compliance?.cdd?.pepStatus,
  },
  {
    descriptor: selectField({
      key: "cdd.intendedUseOfAccount",
      label: "Intended use of account",
      required: true,
      options: enumOptions(COUNTERPARTY_INTENDED_USE),
    }),
    read: (id) => id.compliance?.cdd?.intendedUseOfAccount,
  },
  {
    descriptor: textField({
      key: "cdd.expectedMonthlyVolume.amount",
      label: "Expected monthly volume",
      required: true,
      pattern: "^\\d+(\\.\\d{1,2})?$",
      placeholder: "1000",
    }),
    read: (id) => id.compliance?.cdd?.expectedMonthlyVolume.amount,
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
    read: (id) => id.compliance?.cdd?.estimatedYearlyIncome,
  },
  {
    descriptor: selectField({
      key: "cdd.employmentIndustrySector",
      label: "Employment industry sector",
      required: true,
      options: enumOptions(COUNTERPARTY_INDUSTRY_SECTORS),
    }),
    read: (id) => id.compliance?.cdd?.employmentIndustrySector,
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

export function bvnkOnrampFields(identity: CounterpartyIdentity): BvnkOnrampField[] {
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

export function bvnkCounterpartyRequirements(
  counterparty: Counterparty,
  { direction, providerData, fiatCurrency }: ValidateCounterpartyOptions
): CounterpartyRequirements {
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
  if (counterparty.entityType === "business") {
    return unsupportedCounterparty(
      "bvnk",
      direction,
      "BVNK on-ramp supports individual counterparties only."
    );
  }

  const identity = counterparty.identity;

  if (!identity.address?.countryCode) {
    return unsupportedCounterparty(
      "bvnk",
      direction,
      "Counterparty is missing a stored address country, required for BVNK on-ramp."
    );
  }

  const customer = readBvnkCustomer(providerData);
  if (customer.customerReference) {
    if (!isBvnkCustomerVerified(customer.status)) {
      const phase = bvnkUnverifiedOnboardingStatus(customer.status);
      switch (phase) {
        case "verifying":
          return { provider: "bvnk", direction, status: "customer_verifying" };
        case "verification_failed":
          return { provider: "bvnk", direction, status: "customer_verification_failed" };
        case "verification_required":
          if (!customer.verificationUrl) {
            throw internalError('BVNK reported "verification_required" without a verificationUrl.');
          }
          return {
            provider: "bvnk",
            direction,
            status: "customer_verification_required",
            verificationUrl: customer.verificationUrl,
          };
        default: {
          const exhaustive: never = phase;
          throw internalError(`Unhandled BVNK verification phase: ${String(exhaustive)}`);
        }
      }
    }
    return { provider: "bvnk", direction, status: "funding_account_provisioning" };
  }

  const missingIdentity = [
    identity.firstName ? null : "first name",
    identity.lastName ? null : "last name",
    identity.dateOfBirth ? null : "date of birth",
    identity.address.line1 ? null : "address line 1",
    identity.address.city ? null : "address city",
  ].filter((entry): entry is string => entry !== null);
  if (missingIdentity.length > 0) {
    return unsupportedCounterparty(
      "bvnk",
      direction,
      `Counterparty is missing details required for BVNK on-ramp: ${missingIdentity.join(", ")}.`
    );
  }

  const missing = bvnkOnrampFields(identity)
    .filter((field) => field.read(identity) === undefined)
    .map((field) => field.descriptor);
  if (missing.length === 0) {
    return { provider: "bvnk", direction, status: "onboarding_not_started" };
  }
  return { provider: "bvnk", direction, status: "collect", fields: missing };
}

export function buildBvnkIndividualPayload(
  counterparty: CounterpartyRow,
  collectedData: CollectedFieldData | undefined,
  expectedVolumeCurrency: string
): Record<string, unknown> {
  const identity = counterparty.identity;
  const fields = bvnkOnrampFields(identity);
  const missing = fields.filter((field) => field.read(identity) === undefined);

  let supplied: Record<string, unknown> = {};
  if (missing.length > 0) {
    const result = buildRequirementSchema(missing.map((field) => field.descriptor)).safeParse(
      collectedData
    );
    if (!result.success) {
      throw new AppError(
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
            ...(isUnitedStates ? { stateCode: resolveField("address.stateCode") } : {}),
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
