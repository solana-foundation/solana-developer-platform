import {
  type CustodyProposalState,
  createCustodyProposalState,
  custodyProposalRefusalSchema,
} from "@sdp/types/custody-proposals";
import {
  isFireblocksTransactionCancellable,
  isFireblocksTransactionCancelled,
  isFireblocksTransactionFailed,
} from "@sdp/types/fireblocks";
import { isSuccessfulPaymentTransferStatus, type PaymentTransferStatus } from "@sdp/types/payments";
import { z } from "zod";
import type { CustodyProposalRow } from "@/db/repositories/custody-proposals.repository";
import type { PaymentsRepository, PaymentTransferRow } from "@/db/repositories/payments.repository";
import { transferProposalIntentSchema } from "@/services/domain/signing/admitted-proposer";

/** Versioned, nonsecret account binding; provider credentials are always read live. */
export const fireblocksProposalBindingSchema = transferProposalIntentSchema
  .extend({
    version: z.literal(1),
    provider: z.literal("fireblocks"),
  })
  .strict();

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
  state.alertedAt = facts.proposalRefusalAlertedAt ?? null;
  state.providerPhase = legacyPaymentPhase(row.status, legacyProviderPhase(state));
  state.authorizationState = legacyAuthorizationState(state);
  return state;
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
      return "committed_after_refusal";
    case "unsent":
    case "submitting":
    case "absent":
    case "pending":
    case "executing":
    case "failed":
    case "cancelled":
    case "not_sent":
    case "never_accepted":
      return state.cancelAcknowledgedAt !== null ? "cancel_acknowledged" : "refused";
    default: {
      const exhaustive: never = state.providerPhase;
      return exhaustive;
    }
  }
}

/** Old revisions must see the same submission claim until the rolling window closes. */
export async function claimLegacyProposalSubmission(
  repo: PaymentsRepository,
  proposal: CustodyProposalRow,
  at: string
): Promise<boolean> {
  if (proposal.provider !== "fireblocks") return true;
  return (
    (await repo.claimFireblocksTransferSubmission({
      transferId: proposal.payment_transfer_id,
      organizationId: proposal.organization_id,
      projectId: proposal.project_id,
      now: at,
    })) !== null
  );
}

/** Compatibility projection only, never read back as authority after adoption. */
export function legacyProposalProjection(proposal: CustodyProposalRow): Record<string, unknown> {
  if (proposal.provider !== "fireblocks") return {};
  const { state } = proposal;
  const data: Record<string, unknown> = {};
  if (state.submissionStartedAt !== null)
    data.fireblocksSubmissionStartedAt = state.submissionStartedAt;
  if (state.firstMissingAt !== null) data.fireblocksFirstMissingAt = state.firstMissingAt;
  if (state.providerStatus !== null) data.fireblocksStatus = state.providerStatus;
  data.fireblocksSubStatus = state.providerSubStatus;
  if (state.refusal !== null) data.proposalRefusal = state.refusal;
  if (state.cancelAcknowledgedAt !== null)
    data.proposalCancellationAcceptedAt = state.cancelAcknowledgedAt;
  if (state.alertedAt !== null) data.proposalRefusalAlertedAt = state.alertedAt;
  return data;
}
