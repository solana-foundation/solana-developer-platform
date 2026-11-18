import {
  type CustodyProposalState,
  createCustodyProposalState,
  custodyProposalRefusalSchema,
  custodyProposalStateSchema,
} from "@sdp/types/custody-proposals";
import {
  isFireblocksTransactionCancellable,
  isFireblocksTransactionCancelled,
  isFireblocksTransactionFailed,
} from "@sdp/types/fireblocks";
import { isSuccessfulPaymentTransferStatus, type PaymentTransferStatus } from "@sdp/types/payments";
import { z } from "zod";
import type { PaymentTransferRow } from "@/db/repositories/payments.repository";

const legacyFactsSchema = z.object({
  fireblocksSubmissionStartedAt: z.string().datetime().optional(),
  fireblocksFirstMissingAt: z.string().datetime().optional(),
  fireblocksStatus: z.string().optional(),
  fireblocksSubStatus: z.string().nullable().optional(),
  proposalRefusal: custodyProposalRefusalSchema.optional(),
  proposalCancellationAcceptedAt: z.string().datetime().optional(),
  proposalRefusalAlertedAt: z.string().datetime().optional(),
});

/** Rolling-deploy bridge only; the proposal row owns every new lifecycle decision. */
export function legacyFireblocksProposalState(
  row: Pick<PaymentTransferRow, "status" | "provider_reference" | "provider_data">
): CustodyProposalState {
  const facts = legacyFactsSchema.parse(row.provider_data);
  const state = createCustodyProposalState();
  state.providerTransactionId = row.provider_reference;
  state.providerStatus = facts.fireblocksStatus ?? null;
  state.providerSubStatus = facts.fireblocksSubStatus ?? null;
  state.submissionStartedAt = facts.fireblocksSubmissionStartedAt ?? null;
  state.firstMissingAt = facts.fireblocksFirstMissingAt ?? null;
  state.refusal = facts.proposalRefusal ?? null;
  state.cancelAcknowledgedAt = facts.proposalCancellationAcceptedAt ?? null;
  state.cancelRequestedAt = state.cancelAcknowledgedAt;
  // Old writers recorded only acknowledgment, which proves at least one attempt.
  state.cancelAttempt = state.cancelAcknowledgedAt === null ? 0 : 1;
  state.alertedAt = facts.proposalRefusalAlertedAt ?? null;
  state.providerPhase = legacyPaymentPhase(row.status, legacyProviderPhase(state));
  state.authorizationState = legacyAuthorizationState(state);
  return custodyProposalStateSchema.parse(state);
}

/** The payment's recorded outcome takes precedence over provider progress. */
function legacyPaymentPhase(
  status: PaymentTransferStatus,
  providerPhase: CustodyProposalState["providerPhase"]
): CustodyProposalState["providerPhase"] {
  switch (status) {
    case "failed":
      return providerPhase === "cancelled" ? "cancelled" : "failed";
    case "pending":
    case "processing":
    case "confirmed":
    case "finalized":
    case "awaiting_payment":
    case "settling":
    case "completed":
    case "canceled":
    case "expired":
      return isSuccessfulPaymentTransferStatus(status) ? "completed" : providerPhase;
    default: {
      const exhaustive: never = status;
      return exhaustive;
    }
  }
}

/** A provider failure outranks an accepted ID; an accepted ID outranks absence. */
function legacyProviderPhase(state: CustodyProposalState): CustodyProposalState["providerPhase"] {
  const status = state.providerStatus;
  if (status !== null && isFireblocksTransactionFailed(status)) {
    return isFireblocksTransactionCancelled(status) ? "cancelled" : "failed";
  }
  if (state.providerTransactionId !== null) {
    return status !== null && isFireblocksTransactionCancellable(status) ? "pending" : "executing";
  }
  return legacyUnacceptedPhase(state);
}

/** Missing reads remain recoverable even when the old submission marker is absent. */
function legacyUnacceptedPhase(state: CustodyProposalState): CustodyProposalState["providerPhase"] {
  if (state.firstMissingAt !== null) return "absent";
  return state.submissionStartedAt !== null ? "submitting" : "unsent";
}

function legacyAuthorizationState(
  state: CustodyProposalState
): CustodyProposalState["authorizationState"] {
  if (state.refusal === null) return "authorized";
  switch (state.providerPhase) {
    case "completed":
      return state.alertedAt === null ? "committed_after_refusal" : "refusal_alerted";
    case "unsent":
    case "submitting":
    case "absent":
    case "not_sent":
    case "never_accepted":
      // Historical evidence cannot invent an accepted provider transaction.
      return "refused";
    case "pending":
    case "executing":
    case "failed":
    case "cancelled":
      return state.cancelAcknowledgedAt !== null ? "cancel_acknowledged" : "refused";
    default: {
      const exhaustive: never = state.providerPhase;
      return exhaustive;
    }
  }
}
