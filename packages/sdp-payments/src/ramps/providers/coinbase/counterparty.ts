import type { Counterparty } from "@sdp/types";
import type {
  CollectedFieldData,
  CounterpartyRequirements,
  RequirementField,
} from "@sdp/types/ramp-requirements";
import { badRequest, unsupportedCounterparty } from "../../../errors";
import {
  buildRequirementSchema,
  parseCollectedFields,
  phoneField,
  readyCounterparty,
} from "../../requirements";
import type { ValidateCounterpartyOptions } from "../../types";

const COINBASE_PHONE_FIELDS: readonly RequirementField[] = [phoneField()];

/**
 * Resolves Coinbase phone requirements from transient quote context.
 *
 * @param counterparty Counterparty selected for the ramp.
 * @param options Validated ramp context and transient collected fields.
 * @returns Coinbase counterparty requirements for the requested direction.
 */
export function coinbaseCounterpartyRequirements(
  counterparty: Counterparty,
  options: ValidateCounterpartyOptions
): CounterpartyRequirements {
  if (options.direction !== "onramp") {
    return unsupportedCounterparty(
      "coinbase",
      options.direction,
      "Coinbase Onramp supports on-ramp only."
    );
  }
  if (counterparty.entityType !== "individual") {
    return unsupportedCounterparty(
      "coinbase",
      options.direction,
      "Coinbase Onramp supports individual counterparties only."
    );
  }
  const parsed = buildRequirementSchema(COINBASE_PHONE_FIELDS).safeParse(options.collectedData);
  if (parsed.success) {
    return readyCounterparty("coinbase", options.direction);
  }
  return {
    provider: "coinbase",
    direction: options.direction,
    status: "collect",
    fields: [...COINBASE_PHONE_FIELDS],
  };
}

/**
 * Parses the transient phone number submitted for a Coinbase quote.
 *
 * @param collectedData Transient fields submitted with the quote.
 * @returns A validated E.164 phone number.
 */
export function resolveCoinbasePhone(collectedData: CollectedFieldData | undefined): string {
  if (collectedData === undefined) {
    throw badRequest("Coinbase Onramp requires collectedData with a phone number.");
  }
  const parsed = parseCollectedFields(
    COINBASE_PHONE_FIELDS,
    collectedData,
    "Missing or invalid phone number required for Coinbase Onramp."
  );
  const phone = parsed.phone;
  if (typeof phone !== "string") {
    throw badRequest('Missing required field "phone" for Coinbase Onramp.');
  }
  return phone;
}
