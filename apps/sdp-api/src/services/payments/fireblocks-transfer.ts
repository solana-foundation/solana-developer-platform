import { FireblocksApiError } from "@sdp/custody/provisioning/fireblocks-http";
import type { FireblocksTransferResult } from "@sdp/custody/provisioning/fireblocks-transfers";
import { compareDecimalAmounts, parseDecimalAmount } from "@sdp/solana/amount";
import {
  type CustodyProposalEvent,
  isTerminalCustodyProposalPhase,
} from "@sdp/types/custody-proposals";
import {
  fireblocksPaymentStatus,
  isFireblocksPolicyRefusal,
  isFireblocksTransactionCancellable,
  isFireblocksTransactionCancelled,
  isFireblocksTransactionFailed,
} from "@sdp/types/fireblocks";
import { isSuccessfulPaymentTransferStatus } from "@sdp/types/payments";
import { assertIsSignature } from "@solana/kit";
import type { CustodyProposalRow } from "@/db/repositories/custody-proposals.repository";
import type { PaymentsRepository, PaymentTransferRow } from "@/db/repositories/payments.repository";
import { AppError, badRequest, conflict, custodyPolicyRefusalMessage } from "@/lib/errors";
import { getLogger } from "@/runtime/logger";
import { describeError } from "@/runtime/money-path-events";
import {
  type CustodyTransferProposer,
  transferProposalIntentSchema as intentSchema,
  ProposalNotSentError,
} from "@/services/domain/signing/admitted-proposer";
import { createOrgTransferProposalReader } from "@/services/solana/signer";
import type { Env } from "@/types/env";
import {
  applyProposalEvent,
  applyProposalEventInTransaction,
  type ProposalEventResult,
  type ProposalLedger,
} from "./custody-proposal-ledger";
import {
  fireblocksProposalBindingSchema,
  legacyFireblocksProposalState,
} from "./fireblocks-proposal-compatibility";

/** Adopt legacy facts once; subsequent state belongs to the proposal repository. */
export async function ensureTransferProposal(
  ledger: Pick<ProposalLedger, "repo" | "proposals">,
  row: PaymentTransferRow,
  now: number = Date.now()
): Promise<CustodyProposalRow> {
  const current = await currentRow(ledger.repo, row);
  const binding = fireblocksProposalBindingSchema.parse({
    ...intentSchema.parse(current.provider_data.fireblocksTransfer),
    version: 1,
    provider: "fireblocks",
  });
  const proposal = await ledger.proposals.ensureForTransfer({
    transfer: current,
    provider: "fireblocks",
    binding,
    state: legacyFireblocksProposalState(current),
    now: new Date(now).toISOString(),
  });
  fireblocksProposalBindingSchema.parse(proposal.binding);
  return proposal;
}

export function isFireblocksTransfer(row: PaymentTransferRow): boolean {
  return row.provider_data.fireblocksTransfer !== undefined;
}

function providerFailure(result: FireblocksTransferResult): string {
  const subStatus =
    result.subStatus && /^[A-Z0-9_]{1,100}$/.test(result.subStatus) ? ` (${result.subStatus})` : "";
  const next =
    result.status === "BLOCKED"
      ? " Check this transfer's approval and destination rules in Fireblocks."
      : " Review this transaction in Fireblocks.";
  return `Fireblocks ${result.status}${subStatus}.${next}`;
}

/**
 * What a failed native transfer records. A confirmed policy block keeps the custody policy
 * refusal's message and code, so the row, the dashboard and a replay of its key read like a
 * refused signature (HOO-2478); any other failure keeps Fireblocks' status.
 */
function failureRecord(result: FireblocksTransferResult): {
  error: string;
  providerData: { executionFailure?: { code: "CUSTODY_POLICY_REFUSED" } };
} {
  if (isFireblocksPolicyRefusal(result)) {
    return {
      error: custodyPolicyRefusalMessage("fireblocks"),
      providerData: { executionFailure: { code: "CUSTODY_POLICY_REFUSED" } },
    };
  }
  return { error: providerFailure(result), providerData: {} };
}

async function persistResult(
  ledger: ProposalLedger,
  row: PaymentTransferRow,
  result: FireblocksTransferResult,
  detail: boolean,
  now: number,
  proposal: CustodyProposalRow
): Promise<ProposalEventResult> {
  const intent = fireblocksProposalBindingSchema.parse(proposal.binding);
  if (row.provider_reference && row.provider_reference !== result.id)
    throw conflict("Fireblocks transaction identity changed");
  if (
    detail &&
    (result.externalTxId !== row.id ||
      result.operation !== "TRANSFER" ||
      result.assetId !== intent.assetId ||
      result.source?.type !== "VAULT_ACCOUNT" ||
      result.source.id !== intent.vaultAccountId)
  )
    throw conflict("Fireblocks transaction does not match the payment intent");
  let signature: string | undefined;
  if (result.txHash) {
    assertIsSignature(result.txHash);
    signature = result.txHash;
  }
  // A hash during approval/broadcast can still be replaced. Only COMPLETED is a chain verdict.
  const completed = detail && result.status === "COMPLETED" && signature !== undefined;
  if (completed) {
    if (row.signature !== null && row.signature !== signature)
      throw conflict("Fireblocks settlement signature changed");
    assertSettlement(row, result);
  }
  let fee: number | undefined;
  if (
    completed &&
    (result.feeCurrency === "SOL" || result.feeCurrency === "SOL_TEST") &&
    typeof result.feeInfo?.networkFee === "string"
  ) {
    try {
      const lamports = parseDecimalAmount(result.feeInfo.networkFee, 9);
      if (lamports <= BigInt(Number.MAX_SAFE_INTEGER)) fee = Number(lamports);
    } catch {
      /* An unavailable fee must not prevent recording a confirmed payment. */
    }
  }
  const status = fireblocksPaymentStatus(result.status, completed);
  const refusal = proposal.state.refusal;
  const failure = status === "failed" ? failureRecord(result) : null;
  // A terminal provider cancellation closes the refusal. Its acknowledgment alone never does.
  if (failure && refusal && isFireblocksTransactionCancelled(result.status)) {
    failure.error = refusal.message;
  }
  let phase: Extract<CustodyProposalEvent, { type: "observed" }>["phase"];
  switch (status) {
    case "confirmed":
      phase = "completed";
      break;
    case "failed":
      phase = isFireblocksTransactionCancelled(result.status) ? "cancelled" : "failed";
      break;
    case "processing":
      phase = isFireblocksTransactionCancellable(result.status) ? "pending" : "executing";
      break;
    default: {
      const exhaustive: never = status;
      return exhaustive;
    }
  }
  return applyProposalEvent(
    ledger,
    row,
    proposal,
    {
      type: "observed",
      at: new Date(now).toISOString(),
      phase,
      providerTransactionId: result.id,
      providerStatus: result.status,
      providerSubStatus:
        result.subStatus && /^[A-Z0-9_]{1,100}$/.test(result.subStatus) ? result.subStatus : null,
    },
    {
      signature: completed ? signature : undefined,
      fee,
      error: failure?.error ?? null,
      providerData: failure?.providerData,
    }
  );
}

async function currentRow(repo: PaymentsRepository, row: PaymentTransferRow) {
  const current = await repo.getTransferById({
    transferId: row.id,
    organizationId: row.organization_id,
    projectId: row.project_id,
  });
  if (current === null) throw conflict("The proposal payment no longer exists");
  return current;
}

/** Exactly one create attempt per durable intent. Recovery never sends funds. */
export async function submitProposedTransfer(
  ledger: ProposalLedger,
  row: PaymentTransferRow,
  proposer: CustodyTransferProposer
): Promise<PaymentTransferRow> {
  const { repo } = ledger;
  if (
    !row.destination_address ||
    !row.amount ||
    !row.project_id ||
    !row.custody_wallet_id ||
    !row.source_address
  )
    throw badRequest("Incomplete payment intent");
  const now = Date.now();
  const claim = await ledger.audited(async (repo, proposals) => {
    const proposal = await ensureTransferProposal({ repo, proposals }, row, now);
    return applyProposalEventInTransaction(repo, proposals, row, proposal, {
      type: "submission_claimed",
      at: new Date(now).toISOString(),
    });
  });
  if (!claim.written) return claim.transfer;
  const claimed = claim.transfer;
  try {
    // The waist admits and re-reads the live credential before it sends; nothing captured at
    // prepare time is submitted.
    const result = await proposer.propose({
      externalId: row.id,
      intent: fireblocksProposalBindingSchema.parse(claim.proposal.binding),
      sourceAddress: row.source_address,
      destination: row.destination_address,
      amount: row.amount,
      memo: row.memo,
    });
    return (await persistResult(ledger, claimed, result, false, Date.now(), claim.proposal))
      .transfer;
  } catch (error) {
    if (error instanceof ProposalNotSentError) {
      // A refusal before submission is definitely unsent, unlike an ambiguous provider outcome.
      const refusal = error.cause;
      const message =
        refusal instanceof AppError
          ? refusal.toResponse().error.message
          : "Fireblocks admission failed before submission";
      await recordSubmissionRefusal(
        ledger,
        claimed,
        claim.proposal,
        {
          type: "submission_refused",
          at: new Date().toISOString(),
          error: message,
        },
        {
          error: message,
          providerData: {
            executionFailure: {
              code: refusal instanceof AppError ? refusal.code : "INTERNAL_ERROR",
            },
          },
        }
      );
      throw refusal;
    }
    // A timeout, duplicate-ID conflict, invalid response, or DB failure may follow acceptance.
    // Keep the claim and recover by externalTxId; never turn uncertainty into permission to resend.
    if (error instanceof FireblocksApiError && [400, 401, 403, 422, 429].includes(error.status)) {
      const message = `${error.message}. Check the API user's permissions and Fireblocks destination policy.`;
      return (
        await recordSubmissionRefusal(
          ledger,
          claimed,
          claim.proposal,
          {
            type: "submission_refused",
            at: new Date().toISOString(),
            error: message,
          },
          { error: message }
        )
      ).transfer;
    }
    getLogger().warn(
      { transferId: row.id, ...describeError(error) },
      "fireblocks_transfer_submission_outcome_unknown"
    );
    return currentRow(repo, row);
  }
}

/** Validates provider binding and exact settlement before the shared transition. */
export async function applyProposalObservation(
  ledger: ProposalLedger,
  row: PaymentTransferRow,
  result: FireblocksTransferResult | null,
  now: number,
  proposal: CustodyProposalRow
): Promise<ProposalEventResult> {
  if (result !== null) return persistResult(ledger, row, result, true, now, proposal);
  if (proposal.state.providerTransactionId !== null)
    getLogger().error(
      { transferId: row.id, fireblocksTransactionId: proposal.state.providerTransactionId },
      "fireblocks_known_transaction_missing"
    );
  const observation = await applyProposalEvent(
    ledger,
    row,
    proposal,
    {
      type: "observed_absent",
      at: new Date(now).toISOString(),
    },
    {
      error:
        "Fireblocks still has no transaction for this payment after 24 hours of recovery. Review the payment in Fireblocks before intentionally starting a new transfer.",
    }
  );
  if (observation.written && observation.proposal.state.providerPhase === "never_accepted") {
    getLogger().warn({ transferId: row.id }, "fireblocks_unaccepted_transfer_expired");
  }
  return observation;
}

/**
 * An overlapping older revision may already have verified and recorded settlement.
 * Consume only that terminal ledger proof, through the same transition/audit path,
 * so lost provider access cannot hide completion after a recorded refusal.
 */
export async function reconcileRecordedProposalOutcome(
  ledger: ProposalLedger,
  row: PaymentTransferRow,
  proposal: CustodyProposalRow,
  now: number
): Promise<ProposalEventResult | null> {
  if (row.status === "processing" || isTerminalCustodyProposalPhase(proposal.state.providerPhase))
    return null;
  const binding = fireblocksProposalBindingSchema.parse(proposal.binding);
  const legacyBinding = intentSchema.parse(row.provider_data.fireblocksTransfer);
  if (
    row.custody_wallet_id !== proposal.custody_wallet_id ||
    intentSchema.keyof().options.some((key) => binding[key] !== legacyBinding[key])
  ) {
    throw conflict("The recorded payment does not match the custody proposal binding");
  }
  const recorded = legacyFireblocksProposalState(row);
  const providerTransactionId = row.provider_reference;
  if (providerTransactionId === null || recorded.providerStatus === null) return null;
  let phase: Extract<CustodyProposalEvent, { type: "observed" }>["phase"];
  if (isSuccessfulPaymentTransferStatus(row.status)) {
    if (recorded.providerStatus !== "COMPLETED" || row.signature === null) return null;
    assertIsSignature(row.signature);
    phase = "completed";
  } else if (row.status === "failed" && isFireblocksTransactionFailed(recorded.providerStatus)) {
    phase = isFireblocksTransactionCancelled(recorded.providerStatus) ? "cancelled" : "failed";
  } else return null;
  return applyProposalEvent(
    ledger,
    row,
    proposal,
    {
      type: "observed",
      at: new Date(now).toISOString(),
      phase,
      providerTransactionId,
      providerStatus: recorded.providerStatus,
      providerSubStatus: recorded.providerSubStatus,
    },
    {
      signature: phase === "completed" ? (row.signature ?? undefined) : undefined,
      error: phase === "cancelled" ? (proposal.state.refusal?.message ?? row.error) : row.error,
    }
  );
}

/** Snapshot must precede the external read so a stale observation cannot win. */
export async function recordProposalObservation(
  ledger: ProposalLedger,
  row: PaymentTransferRow,
  result: FireblocksTransferResult | null,
  now: number,
  proposal: CustodyProposalRow
): Promise<PaymentTransferRow> {
  return (await applyProposalObservation(ledger, row, result, now, proposal)).transfer;
}

/** Viewer reconciliation only. It has no admission-restoration or cancellation capability. */
export async function refreshFireblocksTransfer(
  env: Env,
  ledger: ProposalLedger,
  row: PaymentTransferRow
): Promise<PaymentTransferRow> {
  const { repo } = ledger;
  if (
    !isFireblocksTransfer(row) ||
    row.status !== "processing" ||
    !row.project_id ||
    !row.custody_wallet_id
  )
    return row;
  const now = Date.now();
  try {
    await ensureTransferProposal(ledger, row, now);
    const claimed = await ledger.proposals.claimForPoll({
      transferId: row.id,
      organizationId: row.organization_id,
      projectId: row.project_id,
      now: new Date(now).toISOString(),
      polledBefore: new Date(now - 15_000).toISOString(),
    });
    if (!claimed) return currentRow(repo, row);
    // Poll claiming changes scheduling only, never the authority worker's clock.
    const expected = claimed;
    const intent = fireblocksProposalBindingSchema.parse(claimed.binding);
    const reader = await createOrgTransferProposalReader(
      env,
      row.organization_id,
      row.project_id,
      row.custody_wallet_id,
      { ...intent, sourceAddress: row.source_address }
    );
    const result = await reader.read(row.id);
    return await recordProposalObservation(ledger, row, result, now, expected);
  } catch (error) {
    getLogger().warn(
      { transferId: row.id, ...describeError(error) },
      "fireblocks_transfer_status_unavailable"
    );
    return currentRow(repo, row);
  }
}

/** A provider completion must prove the exact net recipient and decimal amount. */
function assertSettlement(row: PaymentTransferRow, result: FireblocksTransferResult): void {
  // Fireblocks may omit destinationAddress before confirmation. A completed
  // transfer must prove the exact destination and net payment, using decimal
  // strings rather than the deprecated floating-point amount fields.
  const amounts = result.amountInfo;
  if (
    result.destinationAddress !== row.destination_address ||
    !row.amount ||
    !amounts?.amount ||
    !amounts.netAmount ||
    compareDecimalAmounts(amounts.amount, row.amount) !== 0 ||
    compareDecimalAmounts(amounts.netAmount, row.amount) !== 0 ||
    (amounts.requestedAmount != null &&
      compareDecimalAmounts(amounts.requestedAmount, row.amount) !== 0)
  )
    throw conflict("Fireblocks settlement does not match the payment destination and amount");
}

/** A definite refusal proves the original call never sent, even after a 404 race. */
async function recordSubmissionRefusal(
  ledger: ProposalLedger,
  row: PaymentTransferRow,
  proposal: CustodyProposalRow,
  event: Extract<CustodyProposalEvent, { type: "submission_refused" }>,
  observation: { error: string; providerData?: Record<string, unknown> }
): Promise<ProposalEventResult> {
  const result = await applyProposalEvent(ledger, row, proposal, event, observation);
  if (result.written) return result;
  // Reapply only this definitive no-send proof, never a stale provider observation.
  // A fresh CAS and the reducer still reject any accepted or terminal outcome.
  return applyProposalEvent(ledger, result.transfer, result.proposal, event, observation);
}
