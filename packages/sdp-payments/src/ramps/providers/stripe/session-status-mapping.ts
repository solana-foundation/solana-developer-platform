import type { CryptoRailId } from "@sdp/types/payment-rails";
import { z } from "zod";
import { SdpPaymentsError } from "#/errors";
import { readString } from "#/json";
import { providerResponseIssues } from "#/ramps/fetch";
import type { RampSettlementEvent } from "#/ramps/types";

const STRIPE_SESSION_STATUS = {
  // Known, but no settlement news: the customer has not started checkout.
  initialized: "ignore",
  requires_payment: "awaiting_payment",
  fulfillment_processing: "settling",
  fulfillment_complete: "settled",
  rejected: "failed",
} as const satisfies Record<string, RampSettlementEvent["kind"]>;

function isTrackedStripeSessionStatus(
  status: string
): status is keyof typeof STRIPE_SESSION_STATUS {
  return Object.hasOwn(STRIPE_SESSION_STATUS, status);
}

/** The rail each Stripe destination currency settles on, on Solana. */
const STRIPE_SOLANA_RAILS = {
  usdc: "usdc.solana",
  sol: "sol.solana",
} as const satisfies Record<string, CryptoRailId>;

function isStripeSolanaCurrency(currency: string): currency is keyof typeof STRIPE_SOLANA_RAILS {
  return Object.hasOwn(STRIPE_SOLANA_RAILS, currency);
}

/** The rail a completed session delivered, or null for an asset SDP does not sell on Solana. */
function stripeDeliveredAssetRail(currency: string, network: string): CryptoRailId | null {
  if (network !== "solana" || !isStripeSolanaCurrency(currency)) {
    return null;
  }
  return STRIPE_SOLANA_RAILS[currency];
}

/** A session text field, read as Stripe's webhook always was: trimmed, and blank or non-text as absent. */
const stripeSessionText = z.unknown().optional().transform(readString);

/** The delivery proof a completed session carries: each field absent or non-blank text. */
const stripeDeliveryProofSchema = z.object({
  destination_amount: z.string().trim().min(1).nullish(),
  transaction_id: z.string().trim().min(1).nullish(),
  wallet_address: z.string().trim().min(1).nullish(),
});

/**
 * The fields SDP reads from a Stripe onramp session: the object a
 * `crypto.onramp_session.updated` webhook carries and a status lookup returns,
 * mapped once for both. `status` stays an open string so a status Stripe ships
 * later maps to an ignore event.
 */
export const stripeOnrampSessionStatusSchema = z.object({
  id: z.string().trim().min(1),
  status: z.string().trim().min(1),
  transaction_details: z
    .object({
      destination_currency: stripeSessionText,
      destination_network: stripeSessionText,
      // Read only once the session completes, then checked as delivery proof.
      destination_amount: z.unknown().optional(),
      transaction_id: z.unknown().optional(),
      wallet_address: z.unknown().optional(),
    })
    .nullish()
    // Every field above is optional, so only a non-object lands here: absent, as ever.
    .catch(undefined),
});
export type StripeOnrampSessionStatus = z.output<typeof stripeOnrampSessionStatusSchema>;

/**
 * Maps a Stripe onramp session to the settlement event its webhook produces.
 * A completed session names the asset it delivered, so settlement can refuse
 * another one, and its chain transaction, for the delivery verifier.
 *
 * @param session - The session a webhook carried or a status lookup returned.
 * @returns The settlement event, or an ignore event for a status SDP does not track.
 * @throws SdpPaymentsError PROVIDER_RESPONSE_INVALID for a completed session without its
 *   destination currency or network, or with malformed delivery proof.
 */
export function stripeSessionSettlementEvent(
  session: StripeOnrampSessionStatus
): RampSettlementEvent {
  if (!isTrackedStripeSessionStatus(session.status)) {
    return {
      provider: "stripe",
      kind: "ignore",
      reason: `unsupported_status:${session.status}`,
      unmappedStatus: session.status,
    };
  }
  const kind = STRIPE_SESSION_STATUS[session.status];
  if (kind === "ignore") {
    return { provider: "stripe", kind, reason: `untracked_status:${session.status}` };
  }
  const reference = session.id;
  if (kind === "failed") {
    return { provider: "stripe", kind, reference, error: "Stripe rejected the on-ramp session." };
  }
  if (kind !== "settled") {
    return { provider: "stripe", kind, reference };
  }
  const details = session.transaction_details;
  const currency = details?.destination_currency;
  const network = details?.destination_network;
  if (currency === undefined || network === undefined) {
    throw new SdpPaymentsError(
      "PROVIDER_RESPONSE_INVALID",
      "A completed Stripe session is missing its destination currency or network",
      { provider: "stripe", outcome: "unknown" }
    );
  }
  const proof = stripeDeliveryProofSchema.safeParse(details);
  if (!proof.success) {
    throw new SdpPaymentsError(
      "PROVIDER_RESPONSE_INVALID",
      "A completed Stripe session has malformed delivery proof",
      { provider: "stripe", outcome: "unknown" },
      { issues: providerResponseIssues(proof.error) }
    );
  }
  const event: Extract<RampSettlementEvent, { kind: "settled" }> = {
    provider: "stripe",
    kind,
    reference,
    deliveredAssetRail: stripeDeliveredAssetRail(currency, network),
  };
  if (proof.data.destination_amount) {
    event.receivedAmount = proof.data.destination_amount;
  }
  if (proof.data.transaction_id) {
    event.onchain = { signature: proof.data.transaction_id };
    if (proof.data.wallet_address) {
      event.onchain.destinationAddress = proof.data.wallet_address;
    }
  }
  return event;
}
