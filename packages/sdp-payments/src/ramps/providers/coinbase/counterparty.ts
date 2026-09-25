import type { Counterparty } from "@sdp/types";
import type { CounterpartyRequirements } from "@sdp/types/ramp-requirements";
import { z } from "zod";
import { unsupportedCounterparty } from "../../../errors";
import { readyCounterparty } from "../../requirements";
import type { ValidateCounterpartyOptions } from "../../types";

/** Coinbase keeps a `userAuthToken` valid for 60 days from the order that issued it. */
export const COINBASE_USER_AUTH_TOKEN_TTL_MS = 60 * 24 * 60 * 60 * 1000;

/**
 * Metadata on the counterparty's Coinbase customer-link row.
 *
 * Coinbase mints no customer of its own; the row exists to hold the reusable
 * `userAuthToken` an embedded order returns, so the next order for the same buyer
 * can skip the one-time codes. The token is a 60-day credential, so it is stored
 * as ciphertext from the custody cipher, never in the clear. A row with no token
 * yet is legal (empty metadata); a token never travels without its expiry, which
 * is how the reader knows when to stop sending it. Nothing else lands here: the
 * buyer's contact stays with Coinbase.
 */
export const coinbaseCustomerLinkMetadataSchema = z.union([
  z.object({}).strict(),
  z
    .object({
      userAuthTokenCiphertext: z.string().min(1),
      /** ISO timestamp after which the token is not sent any more. */
      userAuthTokenExpiresAt: z.string().datetime(),
    })
    .strict(),
]);
export type CoinbaseCustomerLinkMetadata = z.infer<typeof coinbaseCustomerLinkMetadataSchema>;

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
