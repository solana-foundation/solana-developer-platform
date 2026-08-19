import { FeePaymentError, type FeePaymentErrorCode } from "@sdp/payments/fee-payment";
import { getLogger } from "@/runtime/logger";

/**
 * Shared boundary for classifying a fee-payment submission failure.
 *
 * A failure is either provably PRE-BROADCAST (the provider refused before
 * anything reached the network — safe to journal a plain terminal failure)
 * or its outcome is UNKNOWN (the transaction may be on chain even though we
 * got an error). Unknown outcomes must never become terminal `failed`: a
 * terminal failure invites a client retry and a double send. Such rows stay
 * `processing` behind the durable marker below and require manual
 * reconciliation.
 */

/** Stable machine reason surfaced in the 409's `error.details.reason`. */
export const TRANSFER_SUBMISSION_OUTCOME_UNKNOWN_REASON = "transfer_submission_outcome_unknown";

/** Human-facing sentence for the `error` column and the 409 body. Display only. */
export const TRANSFER_SUBMISSION_OUTCOME_UNKNOWN_ERROR =
  "Transfer submission outcome is unknown; reconcile manually before retrying";

/**
 * The durable marker lives in `payment_transfers.provider_data` under this
 * key — NOT in the prose `error` text. Jobs and the operator query match the
 * marker; rewording the sentence above can never un-protect existing rows.
 */
export const SUBMISSION_OUTCOME_UNKNOWN_MARKER = { submission_outcome: "unknown" } as const;

// Codes that assert the provider definitively rejected the call before any
// broadcast. Shared with sponsorship-budget.service.ts's release decision.
export const DETERMINISTIC_REJECTION_CODES: ReadonlySet<FeePaymentErrorCode> = new Set([
  "SIGNING_FAILED",
  "TRANSACTION_TOO_LARGE",
  "INSUFFICIENT_BALANCE",
  "RATE_LIMITED",
]);

/**
 * True when the provider provably refused BEFORE broadcasting anything — a
 * deterministic provider rejection or an in-band simulation error — so a
 * plain terminal failure is safe. Anything else after handing the transaction
 * to the provider is an unknown outcome.
 *
 * The `maybeBroadcast` flag beats both the code and the text: after a lost
 * response, a deterministic-looking rejection can be CAUSED by the hidden
 * broadcast (spent funds -> INSUFFICIENT_BALANCE, consumed quota ->
 * RATE_LIMITED), so it must not vouch that nothing was sent.
 */
export function isPreBroadcastRejection(error: unknown): boolean {
  if (error instanceof FeePaymentError && error.maybeBroadcast) {
    return false;
  }
  if (error instanceof FeePaymentError && DETERMINISTIC_REJECTION_CODES.has(error.code)) {
    return true;
  }
  const message = error instanceof Error ? error.message : "";
  return /custom program error:/i.test(message);
}

/**
 * Persist the manual-reconciliation marker without ever throwing: a DB blip
 * here is likely correlated with the provider trouble that made the outcome
 * ambiguous, and replacing the caller's outcome-unknown 409 with a raw 500
 * invites the exact double-send retry the marker exists to prevent. Retries
 * once; an unmarked row is loudly logged for operator reconciliation.
 */
export async function persistOutcomeUnknownMarker(
  persistMarker: () => Promise<unknown>,
  transferId: string
): Promise<void> {
  try {
    await persistMarker();
  } catch (firstError) {
    try {
      await persistMarker();
    } catch (retryError) {
      getLogger().error(
        {
          transfer_id: transferId,
          reason: TRANSFER_SUBMISSION_OUTCOME_UNKNOWN_REASON,
          first_error: firstError instanceof Error ? firstError.message : String(firstError),
          retry_error: retryError instanceof Error ? retryError.message : String(retryError),
        },
        "failed to persist the submission-outcome-unknown marker; the row may auto-fail — reconcile manually"
      );
    }
  }
}
