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
  RampDirection,
  RequirementField,
} from "@sdp/types/ramp-requirements";
import { z } from "zod";
import type { CounterpartyRow } from "@/db/repositories/counterparty.repository";
import { AppError } from "@/lib/errors";
import {
  buildRequirementSchema,
  enumOptions,
  readyCounterparty,
  selectField,
  textField,
} from "../requirements";

/**
 * One BVNK on-ramp customer-create field: the descriptor to collect it when
 * missing, plus how to read its already-stored value off the counterparty. The
 * single source of truth for both `validateCounterparty` (which fields are
 * unsatisfied) and the quote-time payload merge.
 */
interface BvnkOnrampField {
  descriptor: RequirementField;
  read: (identity: CounterpartyIdentity) => string | undefined;
}

const COUNTRY_OPTIONS = COUNTRIES.map((country) => ({ value: country.code, label: country.name }));
const US_STATE_OPTIONS = US_STATES.map((state) => ({ value: state.code, label: state.name }));

// Built once at module load — option arrays (250+ countries) and descriptors are
// static; only which fields apply (US-only set) depends on the counterparty.
const BVNK_ONRAMP_BASE_FIELDS: BvnkOnrampField[] = [
  {
    descriptor: textField({
      key: "taxIdentification.number",
      label: "Tax identification number (SSN / ITIN)",
      required: true,
      maxLength: 64,
      placeholder: "123-45-6789",
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

export function bvnkCounterpartyRequirements(
  counterparty: Counterparty,
  direction: RampDirection
): CounterpartyRequirements {
  if (direction === "offramp") {
    return readyCounterparty("bvnk", direction);
  }
  if (counterparty.entityType === "business") {
    return {
      provider: "bvnk",
      direction,
      status: "unsupported",
      reason: "BVNK on-ramp supports individual counterparties only.",
    };
  }

  const identity = counterparty.identity;
  const missing = bvnkOnrampFields(identity)
    .filter((field) => field.read(identity) === undefined)
    .map((field) => field.descriptor);

  if (missing.length === 0) {
    return readyCounterparty("bvnk", direction);
  }
  return { provider: "bvnk", direction, status: "collect", fields: missing };
}

/**
 * Builds the BVNK customer-create `individual` payload by merging stored
 * identity with the just-in-time `collectedData` passthrough. Fields already
 * present on the counterparty are read from there; the rest must be supplied in
 * `collectedData` (validated against the recomputed requirement schema). The
 * passthrough is never persisted.
 */
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
      throw new AppError("BAD_REQUEST", `Missing required field "${key}" for BVNK on-ramp.`);
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
      number: resolveField("taxIdentification.number"),
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
