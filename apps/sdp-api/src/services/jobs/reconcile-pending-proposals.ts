import { currentClusterScope } from "@sdp/rpc/scope";
import {
  canRequestCustodyProposalCancellation,
  hasUnalertedCustodyProposalRefusal,
  isCancellableCustodyProposalPhase,
} from "@sdp/types/custody-proposals";
import type {
  ClaimCustodyProposalsInput,
  CustodyProposalRecoveryScope,
  CustodyProposalRow,
} from "@/db/repositories/custody-proposals.repository";
import type { PaymentTransferRow } from "@/db/repositories/payments.repository";
import { mapSettledWithConcurrency } from "@/lib/concurrency";
import { internalError } from "@/lib/errors";
import { runAsRecordedMoneyPrincipal } from "@/lib/money-principal";
import { getLogger } from "@/runtime/logger";
import { describeError } from "@/runtime/money-path-events";
import {
  ProposalAdmissionRefusedError,
  transferProposalIntentSchema,
} from "@/services/domain/signing/admitted-proposer";
import { systemProposalLedger } from "@/services/jobs/proposal-recovery-ledger";
import type { ProposalLedger } from "@/services/payments/custody-proposal-ledger";
import { applyProposalEvent } from "@/services/payments/custody-proposal-ledger";
import {
  applyProposalObservation,
  reconcileRecordedProposalOutcome,
} from "@/services/payments/fireblocks-transfer";
import { createOrgTransferProposalRecovery } from "@/services/solana/signer";
import type { Env } from "@/types/env";

const RECOVERY_PAGE_SIZE = 50;
const RECOVERY_CONCURRENCY = 5;

function identity(proposal: CustodyProposalRow) {
  return {
    transferId: proposal.payment_transfer_id,
    organizationId: proposal.organization_id,
    projectId: proposal.project_id,
  };
}

async function recoverProposal(env: Env, ledger: ProposalLedger, snapshot: CustodyProposalRow) {
  const initial = await ledger.repo.getTransferById(identity(snapshot));
  if (initial === null) throw internalError("Custody proposal payment is missing");
  const recorded = await reconcileRecordedProposalOutcome(ledger, initial, snapshot, Date.now());
  if (recorded !== null) {
    if (recorded.written && hasUnalertedCustodyProposalRefusal(recorded.proposal.state)) {
      await emitRefusalAlert(ledger, recorded.transfer, recorded.proposal);
    }
    return;
  }
  if (snapshot.custody_wallet_id === null)
    throw internalError("Custody proposal wallet is missing");
  const recovery = await createOrgTransferProposalRecovery<"payments">(
    env,
    snapshot.organization_id,
    snapshot.project_id,
    snapshot.custody_wallet_id,
    {
      ...transferProposalIntentSchema.parse(snapshot.binding),
      sourceAddress: initial.source_address,
    },
    "payments.transfer"
  );
  // Pin the expected version before provider I/O. Losing that CAS authorizes no more work.
  const result = await recovery.read(initial.id);
  let current = await applyProposalObservation(ledger, initial, result, Date.now(), snapshot);
  if (hasUnalertedCustodyProposalRefusal(current.proposal.state)) {
    await emitRefusalAlert(ledger, current.transfer, current.proposal);
  }
  if (
    result === null ||
    !current.written ||
    !isCancellableCustodyProposalPhase(current.proposal.state.providerPhase)
  )
    return;
  if (current.proposal.state.refusal === null) {
    let refusal: { reason: string; message: string };
    if (current.transfer.initiated_by_principal === null) {
      refusal = {
        reason: "principal_missing",
        message: "This payment has no recorded initiating principal and cannot remain authorized.",
      };
    } else {
      try {
        await runAsRecordedMoneyPrincipal(current.transfer, () => recovery.admit());
        return;
      } catch (error) {
        // Unavailable admission is not proof of revoked authority.
        if (!(error instanceof ProposalAdmissionRefusedError)) throw error;
        refusal = { reason: error.reason, message: error.message };
      }
    }
    current = await applyProposalEvent(ledger, current.transfer, current.proposal, {
      type: "admission_refused",
      at: new Date().toISOString(),
      ...refusal,
    });
    if (!current.written) return;
  }
  const cancellationAt = new Date().toISOString();
  if (!canRequestCustodyProposalCancellation(current.proposal.state, cancellationAt)) return;
  current = await applyProposalEvent(ledger, current.transfer, current.proposal, {
    type: "cancel_requested",
    at: cancellationAt,
  });
  if (!current.written) return;
  // Only the durable CAS winner calls cancel. A timeout retains retry work; acknowledgment
  // does not settle the payment.
  const accepted = await recovery.cancel(current.transfer.id);
  await applyProposalEvent(ledger, current.transfer, current.proposal, {
    type: accepted ? "cancel_accepted" : "cancel_declined",
    at: new Date().toISOString(),
  });
}

async function recoverDue(env: Env, ledger: ProposalLedger, scope: CustodyProposalRecoveryScope) {
  const environment = currentClusterScope().environment;
  const now = new Date().toISOString();
  const adoption = await Promise.allSettled([
    ledger.proposals.adoptLegacyTransfers({ environment, now, limit: RECOVERY_PAGE_SIZE }),
  ]);
  // A malformed legacy row cannot starve already-recorded proposals. Report the
  // bridge failure after processing them, so the cron still signals failed work.
  const recovery = await Promise.allSettled([
    recoverClaimedProposals(env, ledger, { ...scope, environment, now, limit: RECOVERY_PAGE_SIZE }),
  ]);
  rethrowFailures<number | void>([...adoption, ...recovery]);
}

async function recoverClaimedProposals(
  env: Env,
  ledger: ProposalLedger,
  input: ClaimCustodyProposalsInput
) {
  const proposals = await ledger.proposals.claimDue(input);
  await mapSettledWithConcurrency(proposals, RECOVERY_CONCURRENCY, async (proposal) => {
    try {
      await recoverProposal(env, ledger, proposal);
    } catch (error) {
      getLogger().warn(
        {
          event: "proposal_recovery_unavailable",
          ...identity(proposal),
          pending_age_seconds: Math.max(
            0,
            Math.floor((Date.now() - Date.parse(proposal.created_at)) / 1000)
          ),
          ...describeError(error),
        },
        "proposal_recovery_unavailable"
      );
    }
  });
}

async function emitRefusalAlert(
  ledger: ProposalLedger,
  transfer: PaymentTransferRow,
  proposal: CustodyProposalRow
) {
  const refusal = proposal.state.refusal;
  if (refusal === null) throw internalError("Custody proposal alert has no recorded refusal");
  getLogger().fatal(
    {
      event: "fireblocks_transfer_committed_after_refusal",
      ...identity(proposal),
      refusalReason: refusal.reason,
      refusedAt: refusal.at,
      signature: transfer.signature,
    },
    "fireblocks_transfer_committed_after_refusal"
  );
  await applyProposalEvent(ledger, transfer, proposal, {
    type: "alert_delivered",
    at: new Date().toISOString(),
  });
}

function rethrowFailures<T>(outcomes: readonly PromiseSettledResult<T>[]) {
  const failures = outcomes
    .filter((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected")
    .map((outcome) => outcome.reason);
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, "Custody proposal recovery failed");
}

async function drainAlerts(ledger: ProposalLedger, scope: CustodyProposalRecoveryScope) {
  const proposals = await ledger.proposals.listUnalerted({
    ...scope,
    environment: currentClusterScope().environment,
    limit: RECOVERY_PAGE_SIZE,
  });
  const outcomes = await mapSettledWithConcurrency(
    proposals,
    RECOVERY_CONCURRENCY,
    async (proposal) => {
      try {
        const transfer = await ledger.repo.getTransferById(identity(proposal));
        if (transfer === null) throw internalError("Custody proposal payment is missing");
        await emitRefusalAlert(ledger, transfer, proposal);
      } catch (error) {
        getLogger().warn(
          {
            event: "proposal_refusal_alert_unavailable",
            ...identity(proposal),
            ...describeError(error),
          },
          "proposal_refusal_alert_unavailable"
        );
        throw error;
      }
    }
  );
  rethrowFailures(outcomes);
}

/**
 * Reconcile bounded proposal pages under the dedicated cron identity. Terminal alerts drain
 * independently, including when legacy adoption or the active recovery queue is unavailable.
 */
export async function reconcilePendingProposals(
  env: Env,
  scope: CustodyProposalRecoveryScope = {}
): Promise<void> {
  const ledger = systemProposalLedger(env);
  const outcomes = await Promise.allSettled([
    recoverDue(env, ledger, scope),
    drainAlerts(ledger, scope),
  ]);
  rethrowFailures(outcomes);
}
