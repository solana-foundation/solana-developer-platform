import type { Counterparty, CountryCode } from "@sdp/types";
import type { CollectedFieldData, CounterpartyRequirements } from "@sdp/types/ramp-requirements";
import type { CounterpartyRow } from "../../../counterparty";
import { badRequest, unsupportedCounterparty } from "../../../errors";
import {
  addressFields,
  buildRequirementSchema,
  parseCollectedAddress,
  readyCounterparty,
} from "../../requirements";
import type { ValidateCounterpartyOptions } from "../../types";

export interface StripeCustomerInfo {
  email: string;
  firstName: string;
  lastName: string;
  dob: { year: number; month: number; day: number };
  address: {
    line1: string;
    line2?: string;
    city: string;
    state?: string;
    postalCode: string;
    country: CountryCode;
  };
}

/**
 * Resolves Stripe address requirements from transient quote context.
 *
 * @param counterparty Counterparty selected for the ramp.
 * @param options Validated ramp context and transient collected fields.
 * @returns Stripe counterparty requirements for the requested direction.
 */
export function stripeCounterpartyRequirements(
  counterparty: Counterparty,
  options: ValidateCounterpartyOptions
): CounterpartyRequirements {
  if (options.direction !== "onramp") {
    return unsupportedCounterparty("stripe", options.direction, "Stripe supports on-ramp only.");
  }
  if (counterparty.entityType !== "individual") {
    return unsupportedCounterparty(
      "stripe",
      options.direction,
      "Stripe supports individual counterparties only."
    );
  }
  const fields = addressFields(options.country);
  const parsed = buildRequirementSchema(fields).safeParse(options.collectedData);
  if (parsed.success) {
    return readyCounterparty("stripe", options.direction);
  }
  return {
    provider: "stripe",
    direction: options.direction,
    status: "collect",
    fields: [...fields],
  };
}

/**
 * Parses an ISO date from stored individual identity for Stripe prefill.
 *
 * @param value Stored ISO date of birth.
 * @returns Numeric Stripe date components.
 */
function parseDob(value: string): StripeCustomerInfo["dob"] {
  const parts = value.split("-");
  if (parts.length !== 3) {
    throw badRequest("Counterparty dateOfBirth must be an ISO date for Stripe on-ramp.");
  }
  const [yearPart, monthPart, dayPart] = parts;
  if (yearPart === undefined || monthPart === undefined || dayPart === undefined) {
    throw badRequest("Counterparty dateOfBirth must be an ISO date for Stripe on-ramp.");
  }
  const year = Number.parseInt(yearPart, 10);
  const month = Number.parseInt(monthPart, 10);
  const day = Number.parseInt(dayPart, 10);
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    throw badRequest("Counterparty dateOfBirth must be an ISO date for Stripe on-ramp.");
  }
  return { year, month, day };
}

/**
 * Builds Stripe customer prefill from stored name/DOB and transient address data.
 *
 * @param counterparty Counterparty selected for the quote.
 * @param country Counterparty country supplied for the quote.
 * @param collectedData Transient address values supplied for the quote.
 * @returns Stripe customer information without persisting collected address values.
 */
export function buildStripeCustomerInfo(
  counterparty: CounterpartyRow,
  country: CountryCode,
  collectedData: CollectedFieldData | undefined
): StripeCustomerInfo {
  if (counterparty.entity_type !== "individual") {
    throw badRequest("Stripe on-ramp requires an individual counterparty.");
  }
  const collected = parseCollectedAddress(
    country,
    collectedData,
    "Missing or invalid address details required for Stripe on-ramp."
  );
  const address: StripeCustomerInfo["address"] = {
    line1: collected.line1,
    city: collected.city,
    postalCode: collected.postalCode,
    country,
  };
  if (collected.line2 !== undefined) {
    address.line2 = collected.line2;
  }
  if (collected.subdivisionCode !== undefined) {
    address.state = collected.subdivisionCode;
  }
  return {
    email: counterparty.email,
    firstName: counterparty.identity.firstName,
    lastName: counterparty.identity.lastName,
    dob: parseDob(counterparty.identity.dateOfBirth),
    address,
  };
}
