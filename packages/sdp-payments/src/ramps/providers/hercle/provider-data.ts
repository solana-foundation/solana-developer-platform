import type { CounterpartyRequirements, RampDirection } from "@sdp/types/ramp-requirements";
import { internalError } from "../../../errors";

/**
 * Hercle-side verification lifecycle for a counterparty's sub-account, normalized
 * at write time from the partner API's status vocabulary (see mapHercleVerificationStatus).
 */
export const HERCLE_VERIFICATION_STATUSES = [
  "verification_required",
  "verifying",
  "verification_failed",
  "ready",
] as const;
export type HercleVerificationStatus = (typeof HERCLE_VERIFICATION_STATUSES)[number];

/** Settlement lifecycle carried by `ramp.settlement.status_changed`. */
export const HERCLE_SETTLEMENT_STATUSES = [
  "awaiting_payment",
  "settling",
  "settled",
  "failed",
  "expired",
] as const;
export type HercleSettlementStatus = (typeof HERCLE_SETTLEMENT_STATUSES)[number];

/**
 * Lifecycle of the business's own payout account on Hercle's bank rail, stored verbatim as the
 * `payout_account` row's provider status. Fiat is first-party only, so this is the single account
 * every off-ramp pays to; `pending` until the rail registers it after KYB approval, and an off-ramp
 * order is refused until it is `active`.
 */
export const HERCLE_PAYOUT_ACCOUNT_STATUSES = ["pending", "active", "refused"] as const;
export type HerclePayoutAccountStatus = (typeof HERCLE_PAYOUT_ACCOUNT_STATUSES)[number];

export function isHerclePayoutAccountStatus(value: string): value is HerclePayoutAccountStatus {
  return (HERCLE_PAYOUT_ACCOUNT_STATUSES as readonly string[]).includes(value);
}

/**
 * What the handler resolves from the counterparty's provider-account rows before asking for the
 * requirements arm: the customer link's verification state and the payout account's rail status.
 * Nothing here is PII, and the verification link is never part of it — Hercle mints it per read.
 */
export interface HercleCustomerState {
  verificationStatus?: HercleVerificationStatus;
  payoutAccountStatus?: HerclePayoutAccountStatus;
}

/**
 * Maps the Hercle partner API's verification vocabulary onto the internal lifecycle.
 * Accounts read: `verificationStatus` is UNVERIFIED | VERIFIED; verification read:
 * `status` is action_required | pending | rejected | approved. Unknown values throw
 * rather than defaulting — a silently wrong lifecycle is worse than a loud one.
 */
export function mapHercleVerificationStatus(apiStatus: string): HercleVerificationStatus {
  switch (apiStatus) {
    case "UNVERIFIED":
    case "action_required":
      return "verification_required";
    case "pending":
      return "verifying";
    case "rejected":
      return "verification_failed";
    case "VERIFIED":
    case "approved":
      return "ready";
    default:
      throw internalError(`Hercle returned an unmapped verification status "${apiStatus}".`);
  }
}

/**
 * Internal lifecycle → wire requirements arm.
 * `verification_required` needs the hosted link Hercle minted for this read; without one it is a
 * provisioning bug, not a UX state — throw, never invent a URL.
 * A verified business whose payout account is still pending on the bank rail is not ready:
 * Hercle refuses off-ramp orders until it is active, so the wizard keeps polling instead.
 */
export function hercleOnboardingRequirements(
  state: HercleCustomerState,
  direction: RampDirection,
  verificationUrl?: string
): CounterpartyRequirements {
  switch (state.verificationStatus) {
    case "ready":
      if (state.payoutAccountStatus === "pending") {
        return { provider: "hercle", direction, status: "funding_account_provisioning" };
      }
      if (state.payoutAccountStatus === "refused") {
        return {
          provider: "hercle",
          direction,
          status: "unsupported",
          reason: "Hercle's bank could not register the business's payout account. Contact Hercle.",
        };
      }
      return { provider: "hercle", direction, status: "ready" };
    case "verifying":
      return { provider: "hercle", direction, status: "customer_verifying" };
    case "verification_failed":
      return { provider: "hercle", direction, status: "customer_verification_failed" };
    case "verification_required":
    case undefined: {
      if (!verificationUrl) {
        throw internalError(
          "Hercle counterparty requires verification but no verification URL was provided."
        );
      }
      return {
        provider: "hercle",
        direction,
        status: "customer_verification_required",
        verificationUrl,
      };
    }
  }
}
