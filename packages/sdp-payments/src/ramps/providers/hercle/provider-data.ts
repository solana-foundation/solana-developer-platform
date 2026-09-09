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
 * What the handler resolves from the counterparty's provider-account rows before asking for the
 * requirements arm: the customer link's verification state.
 * Nothing here is PII, and the verification link is never part of it — Hercle mints it per read.
 */
export interface HercleCustomerState {
  verificationStatus?: HercleVerificationStatus;
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
 */
export function hercleOnboardingRequirements(
  state: HercleCustomerState,
  direction: RampDirection,
  verificationUrl?: string
): CounterpartyRequirements {
  switch (state.verificationStatus) {
    case "ready":
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
