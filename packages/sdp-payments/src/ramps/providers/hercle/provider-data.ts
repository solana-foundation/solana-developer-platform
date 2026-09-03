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
 * Lifecycle of the business's own payout account on Hercle's bank rail. Fiat is first-party only,
 * so this is the single account every off-ramp pays to; `pending` until the rail registers it after
 * KYB approval, and an off-ramp order is refused until it is `active`.
 */
export const HERCLE_PAYOUT_ACCOUNT_STATUSES = ["pending", "active", "refused"] as const;
export type HerclePayoutAccountStatus = (typeof HERCLE_PAYOUT_ACCOUNT_STATUSES)[number];

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
  /** Undefined until the payout account has been registered; bank details themselves are never stored. */
  payoutAccountStatus?: HerclePayoutAccountStatus;
}

export function readHercleData(providerData: CounterpartyProviderData): HercleCounterpartyData {
  const hercle = readRecord(providerData.hercle);
  if (hercle === undefined) {
    return {};
  }

  const status = readString(hercle.verificationStatus);
  const payoutStatus = readString(hercle.payoutAccountStatus);
  return {
    accountId: readString(hercle.accountId),
    externalReference: readString(hercle.externalReference),
    verificationStatus: (HERCLE_VERIFICATION_STATUSES as readonly string[]).includes(status ?? "")
      ? (status as HercleVerificationStatus)
      : undefined,
    verificationUrl: readString(hercle.verificationUrl),
    payoutAccountStatus: (HERCLE_PAYOUT_ACCOUNT_STATUSES as readonly string[]).includes(
      payoutStatus ?? ""
    )
      ? (payoutStatus as HerclePayoutAccountStatus)
      : undefined,
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
 * A verified business whose payout account is still pending on the bank rail is not ready:
 * Hercle refuses off-ramp orders until it is active, so the wizard keeps polling instead.
 */
export function hercleOnboardingRequirements(
  data: HercleCounterpartyData,
  direction: RampDirection
): CounterpartyRequirements {
  switch (data.verificationStatus) {
    case "ready":
      if (data.payoutAccountStatus === "pending") {
        return { provider: "hercle", direction, status: "funding_account_provisioning" };
      }
      if (data.payoutAccountStatus === "refused") {
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
