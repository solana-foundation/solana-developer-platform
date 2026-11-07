import {
  HERCLE_APPROVED_VERIFICATION_STATUS,
  HERCLE_SUSPENDED_ACCOUNT_STATUS,
  type HercleVerificationStatus,
  isHercleVerificationStatus,
} from "@sdp/types/ramp-requirements";
import type {
  RampCustomerStatusEvent,
  RampCustomerStatusObservation,
  RampSettlementEvent,
} from "#/ramps/types";

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
 * Read right after Hercle showed the account not suspended, it replaces a suspension recorded before that showing.
 * It then carries the showing's time, so a suspension recorded while SDP read the verdict stays in place.
 *
 * @param verdict - Hercle's verdict, or null while the business's verification has not started.
 * @param observedAt - When Hercle reported it; with `accountActive`, when SDP asked what showed the account active.
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
