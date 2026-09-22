import type { Counterparty, CountryCode } from "@sdp/types";
import type {
  CollectedFieldData,
  CounterpartyRequirements,
  RampDirection,
} from "@sdp/types/ramp-requirements";
import { badRequest, unsupportedCounterparty } from "../../../errors";
import { parseCollectedFields } from "../../requirements";
import type { ValidateCounterpartyOptions } from "../../types";
import { BVNK_FUNDING_WALLET_FIAT } from "./provider-data";
import { BVNK_RESIDENCE_FIELDS, bvnkOnrampFields } from "./requirements";
import { type BvnkCustomerIndividual, bvnkV2CddSchema } from "./schemas";

function collectedString(data: Record<string, unknown>, key: string): string {
  const value = data[key];
  if (typeof value !== "string" || value.length === 0) {
    throw badRequest(`Missing required BVNK field "${key}".`);
  }
  return value;
}

/**
 * Parses the first-step residence country from collected data.
 *
 * @param collectedData - Flattened fields supplied for this request.
 * @returns The onboardable residence country. The field's options enum already
 * rejects prohibited countries, so no second check is needed.
 */
export function parseBvnkResidenceCountry(collectedData: CollectedFieldData): CountryCode {
  const parsed = parseCollectedFields(
    BVNK_RESIDENCE_FIELDS,
    collectedData,
    "Missing or invalid BVNK residence country."
  );
  const value = collectedString(parsed, "taxIdentification.taxResidenceCountryCode");
  return value as CountryCode;
}

/**
 * Builds the BVNK individual request from transient collected fields.
 *
 * @param collectedData - Flattened PII fields supplied for this request.
 * @param residenceCountry - The counterparty's residence country, collected in
 * the first step and stored on the customer link.
 * @returns A typed BVNK individual request. No collected value is persisted.
 */
export function buildBvnkCustomerRequest(
  collectedData: CollectedFieldData,
  residenceCountry: CountryCode
): BvnkCustomerIndividual {
  const data = parseCollectedFields(
    bvnkOnrampFields(residenceCountry),
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
    nationality: collectedString(data, "nationality"),
    taxIdentification: {
      number: collectedString(data, "taxIdentification.number"),
      taxResidenceCountryCode: residenceCountry,
    },
    cdd,
  };
}

/**
 * @param direction - Ramp direction the residence requirement is answered for.
 * @returns The first-step BVNK residence-collection requirement.
 */
export function bvnkResidenceRequired(direction: RampDirection): CounterpartyRequirements {
  return {
    provider: "bvnk",
    direction,
    status: "collect_counterparty_residence",
    fields: BVNK_RESIDENCE_FIELDS,
  };
}

export function validateBvnkCounterparty(
  counterparty: Counterparty,
  options: ValidateCounterpartyOptions
): CounterpartyRequirements {
  const { direction, fiatCurrency } = options;

  if (fiatCurrency !== undefined && fiatCurrency !== BVNK_FUNDING_WALLET_FIAT) {
    return unsupportedCounterparty("bvnk", direction, "BVNK supports USD only.");
  }
  if (counterparty.entityType !== "individual") {
    return unsupportedCounterparty(
      "bvnk",
      direction,
      "BVNK supports individual counterparties only."
    );
  }
  return bvnkResidenceRequired(direction);
}
