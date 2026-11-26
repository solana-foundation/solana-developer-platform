import { z } from "zod";
import type { CustodyProposalRow } from "@/db/repositories/custody-proposals.repository";
import type { PaymentsRepository } from "@/db/repositories/payments.repository";
import { transferProposalIntentSchema } from "@/services/custody/signing/admitted-proposer";

/** Versioned, nonsecret account binding; provider credentials are always read live. */
export const fireblocksProposalBindingSchema = transferProposalIntentSchema
  .extend({
    version: z.literal(1),
    provider: z.literal("fireblocks"),
  })
  .strict();

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
