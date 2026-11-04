import type {
  RampCustomerStatusEvent,
  RampCustomerStatusObservation,
  RampSettlementEvent,
} from "#/ramps/types";

/** Hercle's verdicts on a business's KYB, as its verification endpoints and its verification webhook report them. */
export const HERCLE_VERIFICATION_STATUSES = [
  "action_required",
  "pending",
  "rejected",
  "approved",
] as const;
export type HercleVerificationStatus = (typeof HERCLE_VERIFICATION_STATUSES)[number];

/** The verdict that lets a business place orders; Hercle refuses an order under any other. */
export const HERCLE_APPROVED_VERIFICATION_STATUS = "approved" satisfies HercleVerificationStatus;

/**
 * The status SDP records for a business whose financial operations Hercle has suspended.
 * Hercle refuses its orders with `ACCOUNT_SUSPENDED` whatever its verdict.
 * Its account read reports `financialStatus: "Suspended"`.
 * Hercle sends no event for it, so SDP learns it from a refused order and sees it lifted only by reading the account.
 */
export const HERCLE_SUSPENDED_ACCOUNT_STATUS = "suspended";

function isHercleVerificationStatus(status: string): status is HercleVerificationStatus {
  return HERCLE_VERIFICATION_STATUSES.some((verdict) => verdict === status);
}

/**
 * The instant a Hercle event stamped `epochSeconds` counts as observed.
 * Hercle stamps its events in whole seconds, so an event counts from the last millisecond of its second.
 * It then outdates every read SDP sent within that second, which Hercle may have answered before the change the event reports.
 * Two events of the same second meet as a tie.
 */
export function hercleEventObservedAt(epochSeconds: number): string {
  return new Date(epochSeconds * 1000 + 999).toISOString();
}

/**
 * A verdict Hercle reported, or null when it holds none, as SDP records it on the business's link.
 * A verdict cannot show a suspension, so it leaves a recorded one in place.
 * Read right after the account showed no suspension, it replaces one.
 *
 * @param verdict - Hercle's verdict, or null while the business's verification has not started.
 * @param observedAt - When Hercle reported it.
 * @param accountActive - Whether Hercle showed in the same exchange that the account is not suspended.
 * @returns The observation for the link store.
 */
export function hercleVerdictObservation(
  verdict: HercleVerificationStatus | null,
  observedAt: string,
  accountActive: boolean
): RampCustomerStatusObservation {
  return {
    providerStatus: verdict,
    observedAt,
    winsTie: verdict !== HERCLE_APPROVED_VERIFICATION_STATUS,
    preserves: accountActive ? [] : [HERCLE_SUSPENDED_ACCOUNT_STATUS],
  };
}

/** A suspension Hercle reported, as SDP records it on the business's link. */
export function hercleSuspensionObservation(observedAt: string): RampCustomerStatusObservation {
  return {
    providerStatus: HERCLE_SUSPENDED_ACCOUNT_STATUS,
    observedAt,
    winsTie: true,
    preserves: [],
  };
}

/**
 * Maps Hercle's `customer.verification.status_changed` webhook to the event SDP records on the business's link.
 * The envelope's `timestamp` orders it, since Hercle sends no delivery id or per-account sequence.
 *
 * @param event - The account the event names, the verdict it carries, and the envelope's Unix seconds.
 * @returns The customer status event, or an ignore event for a verdict SDP does not know.
 */
export function hercleVerificationStatusEvent(event: {
  accountId: string;
  status: string;
  timestamp: number;
}): RampCustomerStatusEvent | Extract<RampSettlementEvent, { kind: "ignore" }> {
  if (!isHercleVerificationStatus(event.status)) {
    return { provider: "hercle", kind: "ignore", reason: `unsupported_status:${event.status}` };
  }
  return {
    provider: "hercle",
    kind: "customer_status",
    providerCustomerReference: event.accountId,
    observation: hercleVerdictObservation(
      event.status,
      hercleEventObservedAt(event.timestamp),
      false
    ),
  };
}
