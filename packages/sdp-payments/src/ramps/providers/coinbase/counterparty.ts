import type { Counterparty } from "@sdp/types";
import type { CounterpartyRequirements } from "@sdp/types/ramp-requirements";
import { unsupportedCounterparty } from "../../../errors";
import { readyCounterparty } from "../../requirements";
import type { ValidateCounterpartyOptions } from "../../types";

/**
 * Coinbase's requirements decision. Pure: no HTTP, no DB.
 *
 * Coinbase Onramp is a consumer product that verifies one natural person inside its
 * hosted flow (embedded orders), so there is nothing to collect here: an individual on
 * the on-ramp is ready to quote, a business has no single person to verify and is
 * refused with a reason the wizard can show, and off-ramp is not offered at all.
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
  return readyCounterparty("coinbase", options.direction);
}
