import type { CounterpartyProviderData } from "@sdp/types/counterparties";
import type { CounterpartyRequirements, RampDirection } from "@sdp/types/ramp-requirements";
import { internalError } from "../../../errors";
import { readRecord, readString } from "../../../json";

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
 * Shape of `counterparty.provider_data.hercle`. Only metadata lands here — ids,
 * statuses and the hosted verification link; collected KYB data is passed to the
 * Hercle API and never persisted.
 */
export interface HercleCounterpartyData {
  /** Hercle sub-account id; the `on-behalf-of` value for every scoped call. */
  accountId?: string;
  /** SDP-side external reference the sub-account was registered under (the counterparty id). */
  externalReference?: string;
  verificationStatus?: HercleVerificationStatus;
  /** Single-use hosted verification link, present while status is verification_required. */
  verificationUrl?: string;
}

export function readHercleData(providerData: CounterpartyProviderData): HercleCounterpartyData {
  const hercle = readRecord(providerData.hercle);
  if (hercle === undefined) {
    return {};
  }

  const status = readString(hercle.verificationStatus);
  return {
    accountId: readString(hercle.accountId),
    externalReference: readString(hercle.externalReference),
    verificationStatus: (HERCLE_VERIFICATION_STATUSES as readonly string[]).includes(status ?? "")
      ? (status as HercleVerificationStatus)
      : undefined,
    verificationUrl: readString(hercle.verificationUrl),
  };
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
 * Internal lifecycle → wire requirements arm. `verification_required` without a
 * stored link is a provisioning bug, not a UX state — throw, never invent a URL.
 */
export function hercleOnboardingRequirements(
  data: HercleCounterpartyData,
  direction: RampDirection
): CounterpartyRequirements {
  switch (data.verificationStatus) {
    case "ready":
      return { provider: "hercle", direction, status: "ready" };
    case "verifying":
      return { provider: "hercle", direction, status: "customer_verifying" };
    case "verification_failed":
      return { provider: "hercle", direction, status: "customer_verification_failed" };
    case "verification_required":
    case undefined: {
      if (!data.verificationUrl) {
        throw internalError(
          "Hercle counterparty requires verification but no verification URL is stored."
        );
      }
      return {
        provider: "hercle",
        direction,
        status: "customer_verification_required",
        verificationUrl: data.verificationUrl,
      };
    }
  }
}
