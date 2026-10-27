/**
 * Background Job: Track Pending Transfers
 *
 * Runs on the API cron schedule to reconcile transfer statuses:
 *
 * 1. Recover stuck "processing" transfers with no signature — created by
 *    executeTransfer but the process may have crashed before receiving a signature.
 *    Mark them failed after 5 minutes.
 *
 * 2. Sync on-chain status for "processing" transfers that do have a signature —
 *    these are submitted transactions whose final confirmation may not have been
 *    recorded due to a timeout or process crash. We batch-check their statuses via
 *    getSignatureStatuses and update DB accordingly.
 *
 * 3. Upgrade "confirmed" transfers to "finalized" once the cluster reports
 *    finality — confirmed is transitional, not terminal.
 *
 * Runs inside one cluster scope per environment (a `cluster` Cron Definition): each run selects only
 * transfers whose project is in the scope's environment and reads them through that cluster.
 */

import { createClusterRpc } from "@sdp/rpc/factory";
import { currentClusterScope } from "@sdp/rpc/scope";
import type { SignatureStatusInfo, SolanaRpc } from "@sdp/rpc/solana";
import { getSignatureStatuses } from "@sdp/rpc/solana";
import { withTransientRpcRetry } from "@sdp/rpc/transient";
import type { TransferChainVerdictStatus } from "@sdp/types/payments";
import { WALLET_TRANSFER_TYPES } from "@sdp/types/payments";
import { assertIsSignature, commitmentComparator, type Signature } from "@solana/kit";
import type {
  ConfirmedTransferPollVerdict,
  PaymentsRepository,
  PaymentTransferRow,
  UpdatePaymentTransferInput,
} from "@/db/repositories/payments.repository";
import {
  createSystemPaymentsRepository,
  createSystemPaymentTransferBatchesRepository,
} from "@/db/repositories/repository-factory";
import { mapSettledWithConcurrency } from "@/lib/concurrency";
import { internalError } from "@/lib/errors";
import { getLogger } from "@/runtime/logger";
import { logEvent } from "@/runtime/money-path-events";
import { refreshFireblocksTransfer } from "@/services/payments/fireblocks-transfer";
import type { Env } from "@/types/env";

// Allow 5 minutes before treating a signature-less "processing" transfer as stuck.
export const STUCK_PROCESSING_AFTER_MS = 5 * 60 * 1000;
// getSignatureStatuses accepts at most 256 signatures per call.
const MAX_SIGNATURES_PER_BATCH = 256;
// A confirmed transaction finalizes within ~30s or never (fork, ledger reset);
// past this window (anchored on confirmed_at, which never moves once set) a
// still-confirmed row ages out of the finalization poll and rests at
// confirmed instead of costing an RPC history search forever.
const CONFIRMED_FINALIZATION_WINDOW_MS = 24 * 60 * 60 * 1000;

type PaymentTransferWithSignature = PaymentTransferRow & { signature: Signature };
type PaymentTransferWithSignedSubmission = PaymentTransferWithSignature & {
  signed_transaction: string;
  last_valid_block_height: string;
};

function hasValidStoredSignature(
  transfer: PaymentTransferRow
): transfer is PaymentTransferWithSignature {
  try {
    if (transfer.signature === null) {
      throw new Error("Stored transfer signature is null");
    }
    assertIsSignature(transfer.signature);
    return true;
  } catch (err) {
    getLogger().error(
      {
        transfer_id: transfer.id,
        error: err instanceof Error ? err.message : String(err),
      },
      "trackPendingTransfers: stored transfer signature is invalid"
    );
    return false;
  }
}

function partitionByValidStoredSignature(transfers: PaymentTransferRow[]) {
  const valid: PaymentTransferWithSignature[] = [];
  const invalid: PaymentTransferRow[] = [];
  for (const transfer of transfers) {
    if (hasValidStoredSignature(transfer)) {
      valid.push(transfer);
    } else {
      invalid.push(transfer);
    }
  }
  return { valid, invalid };
}

/**
 * Applies a terminal status to a transfer. Batch chunks settle through
 * settleTransferBatch, which atomically claims the transfer row from
 * processing, settles its recipients, and recomputes the parent batch — a
 * concurrent run that already settled the chunk makes this a no-op, so a
 * delayed observation can never regress a newer terminal status. Other
 * transfers settle through a processing-guarded update with the same
 * no-op-on-conflict semantics.
 */
async function updateTerminalTransfer(
  env: Env,
  repo: PaymentsRepository,
  transfer: PaymentTransferRow,
  input: UpdatePaymentTransferInput &
    (
      | { status: Exclude<TransferChainVerdictStatus, "failed"> }
      | { status: "failed"; error: string }
    )
): Promise<void> {
  if (transfer.type === "transfer_batch") {
    if (transfer.project_id === null) {
      throw internalError("Transfer batch transfer is missing a project");
    }
    await createSystemPaymentTransferBatchesRepository(env).settleTransferBatch({
      transferId: transfer.id,
      requireUnsigned: input.requireUnsigned,
      organizationId: transfer.organization_id,
      projectId: transfer.project_id,
      transferStatus: input.status,
      error: input.status === "failed" ? input.error : null,
      slot: input.slot === undefined ? null : input.slot,
      updatedAt: input.updatedAt,
      requireUnstarted: input.requireUnstarted,
    });
    return;
  }
  await repo.updateTransfer({ ...input, expectedStatus: "processing" });
}

/**
 * Applies a complete on-chain verdict to one processing transfer. A null
 * verdict is terminal only after a successful transaction-history lookup or
 * durable proof that broadcast never started; recent-cache misses alone must
 * not be passed here.
 */
async function applyOnChainVerdict(
  env: Env,
  repo: PaymentsRepository,
  transfer: PaymentTransferRow,
  status: SignatureStatusInfo | null,
  nowIso: string
): Promise<boolean> {
  try {
    if (!status) {
      await updateTerminalTransfer(env, repo, transfer, {
        transferId: transfer.id,
        status: "failed",
        error: "Transaction not found on chain",
        updatedAt: nowIso,
        // With signed bytes, absence is definitive only while broadcast has
        // not started. Recheck that proof in SQL, not just on the selected row.
        requireUnstarted: transfer.signed_transaction !== null ? true : undefined,
      });
      return true;
    }

    // An error seen only at "processed" may be on a fork the cluster drops, and
    // the same signed transaction can still land; failing the row here would
    // let a retry pay twice (APE SOLA9-708).
    const committed =
      status.confirmationStatus !== null &&
      commitmentComparator(status.confirmationStatus, "confirmed") >= 0;
    if (!committed) {
      return false;
    }

    if (status.err) {
      await updateTerminalTransfer(env, repo, transfer, {
        transferId: transfer.id,
        status: "failed",
        slot: Number(status.slot),
        error: JSON.stringify(status.err),
        updatedAt: nowIso,
      });
      return true;
    }

    if (
      status.confirmationStatus !== null &&
      commitmentComparator(status.confirmationStatus, "finalized") >= 0
    ) {
      await updateTerminalTransfer(env, repo, transfer, {
        transferId: transfer.id,
        status: "finalized",
        slot: Number(status.slot),
        updatedAt: nowIso,
      });
      return true;
    }
    await updateTerminalTransfer(env, repo, transfer, {
      transferId: transfer.id,
      status: "confirmed",
      slot: Number(status.slot),
      updatedAt: nowIso,
    });
    return true;
  } catch (err) {
    getLogger().error(
      {
        transfer_id: transfer.id,
        error: err instanceof Error ? err.message : String(err),
      },
      "trackPendingTransfers: failed to update transfer"
    );
    return false;
  }
}

export async function trackPendingTransfers(env: Env): Promise<void> {
  const repo = createSystemPaymentsRepository(env);
  const now = new Date();
  const nowIso = now.toISOString();

  await recoverStuckProcessingTransfers(env, repo, now, nowIso);
  await syncProcessingTransfersOnChain(env, repo, nowIso);
  await finalizeConfirmedTransfers(repo, now, nowIso);
  await failStrandedTransferBatches(env, now);

  // Human approvals have no five-minute signing timeout. This path only reads
  // the provider; a missing/ambiguous create response can never trigger a POST.
  const fireblocks = await repo.listTransfersByStatus({
    environment: currentClusterScope().environment,
    statuses: ["processing"],
    fireblocks: true,
    limit: 50,
  });
  await mapSettledWithConcurrency(fireblocks, 5, (transfer) =>
    refreshFireblocksTransfer(env, repo, transfer)
  );
}

/** Past any request's lifetime (renewal cap plus lease), with room to spare. */
const STRANDED_BATCH_AGE_MS = 60 * 60 * 1000;
const STRANDED_BATCH_PAGE_SIZE = 50;

/**
 * Settles batches whose request died after the batch and its recipients
 * committed but before a chunk transfer was written (HOO-1918). Those
 * recipients were never sent (a chunk's transfer row and links commit before
 * its broadcast), and no transfer row exists for the sweep above to settle, so
 * without a same-key retry the batch would stay processing forever. They are
 * failed and the batch status recomputed, as the record finder does on a retry.
 */
async function failStrandedTransferBatches(env: Env, now: Date): Promise<void> {
  const batches = createSystemPaymentTransferBatchesRepository(env);
  const stranded = await batches.listStrandedTransferBatches({
    environment: currentClusterScope().environment,
    createdBefore: new Date(now.getTime() - STRANDED_BATCH_AGE_MS).toISOString(),
    limit: STRANDED_BATCH_PAGE_SIZE,
  });
  for (const batch of stranded) {
    await batches.failUnsentTransferRecipients({
      ...batch,
      error: "The batch request ended before this recipient's transfer was sent",
    });
  }
}

/**
 * Upgrades confirmed transfers to finalized once the cluster reports finality.
 *
 * Upgrade-only by design: a confirmed transfer whose status reads null or err
 * keeps its status and rotates to the back of the poll queue — the funds were
 * already observed on chain, so this pass never introduces a new failure
 * path. Each such read is logged as `sdp_api_payment_finalization_unproven`
 * instead: a null can be an honest archival miss, so it is not proof of a
 * fork. Every finalized row — batch parents included — upgrades through one
 * set-based update guarded on still being confirmed (never
 * settleTransferBatch, which only claims from processing and whose recipient
 * settlement already ran): the upgrade changes no recipient or batch state.
 *
 * Polls with searchTransactionHistory because a transaction typically
 * finalizes (~30s) and leaves the node's short recent-status cache before the
 * next tick on the managed five-minute cadence; without it every confirmed
 * row would read null forever.
 *
 * Polls one page per tick as a least-recently-polled queue: rows are ordered
 * by finalization_last_polled_at (never-polled first), and
 * advanceConfirmedTransfers stamps it on every polled row, rotating the row
 * to the back — updated_at stays a domain timestamp and moves only on real
 * finalization. A fixed oldest-first prefix would let stuck rows permanently
 * starve every transfer behind them; rotation polls each eligible row within
 * backlog/page-size successful queue advances at a constant one RPC call per
 * tick (overlapping runtimes degrade to duplicate polls, never lost or
 * regressed state — every write is guarded on status). A failed RPC batch
 * still rotates the page, so a poisoned signature cannot pin it. The poll
 * only covers rows confirmed within CONFIRMED_FINALIZATION_WINDOW_MS: past
 * that window the transaction will never finalize, so the row rests at
 * confirmed and stops costing RPC.
 *
 * @param repo - System payments repository.
 * @param now - Tick time anchoring the finalization window.
 * @param nowIso - Timestamp applied to every polled row.
 * @returns Resolves when the page's poll has been recorded.
 */
async function finalizeConfirmedTransfers(
  repo: PaymentsRepository,
  now: Date,
  nowIso: string
): Promise<void> {
  const windowFloor = new Date(now.getTime() - CONFIRMED_FINALIZATION_WINDOW_MS).toISOString();
  const { valid: confirmedTransfers, invalid } = partitionByValidStoredSignature(
    await repo.listConfirmedTransfersToPoll({
      environment: currentClusterScope().environment,
      confirmedAfter: windowFloor,
      limit: MAX_SIGNATURES_PER_BATCH,
    })
  );

  if (invalid.length > 0) {
    await repo.advanceConfirmedTransfers({
      polled: invalid.map(
        (transfer): ConfirmedTransferPollVerdict => ({
          transferId: transfer.id,
          organizationId: transfer.organization_id,
          finalized: false,
          slot: null,
        })
      ),
      updatedAt: nowIso,
    });
  }

  if (confirmedTransfers.length === 0) {
    return;
  }

  const signatures = confirmedTransfers.map((transfer) => transfer.signature);

  let statuses: Array<SignatureStatusInfo | null>;
  try {
    const rpc = createClusterRpc();
    statuses = await getSignatureStatuses(rpc, signatures, {
      searchTransactionHistory: true,
    });
  } catch (err) {
    getLogger().error(
      {
        error: err instanceof Error ? err.message : String(err),
        environment: currentClusterScope().environment,
      },
      "trackPendingTransfers: getSignatureStatuses RPC call failed for confirmed transfers"
    );
    await repo.advanceConfirmedTransfers({
      polled: confirmedTransfers.map(
        (transfer): ConfirmedTransferPollVerdict => ({
          transferId: transfer.id,
          organizationId: transfer.organization_id,
          finalized: false,
          slot: null,
        })
      ),
      updatedAt: nowIso,
    });
    return;
  }

  if (statuses.length !== signatures.length) {
    throw internalError(
      `getSignatureStatuses returned ${statuses.length} statuses for ${signatures.length} signatures`
    );
  }

  const polled = confirmedTransfers.map(
    (transfer, i): ConfirmedTransferPollVerdict & { signature: string } => {
      const status = statuses[i];
      const base = {
        transferId: transfer.id,
        organizationId: transfer.organization_id,
        signature: transfer.signature,
      };
      return status &&
        !status.err &&
        status.confirmationStatus !== null &&
        commitmentComparator(status.confirmationStatus, "finalized") >= 0
        ? { ...base, finalized: true, slot: Number(status.slot) }
        : { ...base, finalized: false, slot: null };
    }
  );

  await repo.advanceConfirmedTransfers({ polled, updatedAt: nowIso });

  for (const [i, transfer] of confirmedTransfers.entries()) {
    const status = statuses[i];
    if (status && !status.err) continue;
    logEvent("warn", {
      event: "sdp_api_payment_finalization_unproven",
      flow: "reconciler",
      reason: status ? "transaction_error" : "status_missing",
      organization_id: transfer.organization_id,
      project_id: transfer.project_id,
      transfer_id: transfer.id,
      transfer_type: transfer.type,
      signature: transfer.signature,
      confirmed_at: transfer.confirmed_at,
      transaction_error: status ? JSON.stringify(status.err) : null,
    });
  }

  const finalized = polled.filter((transfer) => transfer.finalized);
  for (const transfer of finalized) {
    logEvent("info", {
      event: "sdp_api_payment_chain_finality_observed",
      observation_source: "rpc",
      transfer_id: transfer.transferId,
      organization_id: transfer.organizationId,
      signature: transfer.signature,
      slot: transfer.slot,
    });
  }
  if (finalized.length > 0) {
    getLogger().info(
      { finalized: finalized.length, polled: polled.length },
      "trackPendingTransfers: finalized confirmed transfers"
    );
  }
}

/**
 * Fail processing transfers that have no signature and have been stuck for
 * longer than the recovery threshold, indicating the process crashed before
 * obtaining a signature.
 */
async function recoverStuckProcessingTransfers(
  env: Env,
  repo: PaymentsRepository,
  now: Date,
  nowIso: string
): Promise<void> {
  const cutoff = new Date(now.getTime() - STUCK_PROCESSING_AFTER_MS).toISOString();

  const stuckProcessing = await repo.listTransfersByStatus({
    environment: currentClusterScope().environment,
    statuses: ["processing"],
    types: WALLET_TRANSFER_TYPES,
    hasSignature: false,
    fireblocks: false,
    updatedBefore: cutoff,
    limit: MAX_SIGNATURES_PER_BATCH,
  });

  for (const transfer of stuckProcessing) {
    try {
      await updateTerminalTransfer(env, repo, transfer, {
        transferId: transfer.id,
        status: "failed",
        error: "Transfer processing timed out",
        requireUnsigned: true,
        updatedAt: nowIso,
      });
    } catch (err) {
      getLogger().error(
        {
          transfer_id: transfer.id,
          error: err instanceof Error ? err.message : String(err),
        },
        "trackPendingTransfers: failed to recover stuck processing transfer"
      );
    }
  }
}

/**
 * Query on-chain status for processing transfers that have a signature and
 * update the DB with confirmed / finalized / failed as appropriate.
 */
async function syncProcessingTransfersOnChain(
  env: Env,
  repo: PaymentsRepository,
  nowIso: string
): Promise<void> {
  const { valid: processingWithSig, invalid } = partitionByValidStoredSignature(
    await repo.listTransfersByStatus({
      environment: currentClusterScope().environment,
      statuses: ["processing"],
      types: WALLET_TRANSFER_TYPES,
      hasSignature: true,
      fireblocks: false,
      limit: MAX_SIGNATURES_PER_BATCH,
    })
  );

  for (const transfer of invalid) {
    try {
      await repo.updateTransfer({
        transferId: transfer.id,
        expectedStatus: "processing",
        updatedAt: nowIso,
      });
    } catch (err) {
      getLogger().error(
        {
          transfer_id: transfer.id,
          error: err instanceof Error ? err.message : String(err),
        },
        "trackPendingTransfers: failed to rotate transfer with invalid signature"
      );
    }
  }

  if (processingWithSig.length === 0) {
    return;
  }

  const signatures = processingWithSig.map((transfer) => transfer.signature);

  let statuses: Array<SignatureStatusInfo | null>;

  let rpc: SolanaRpc;
  try {
    rpc = createClusterRpc();
    statuses = await getSignatureStatuses(rpc, signatures);
  } catch (err) {
    getLogger().error(
      {
        error: err instanceof Error ? err.message : String(err),
        environment: currentClusterScope().environment,
      },
      "trackPendingTransfers: getSignatureStatuses RPC call failed"
    );
    return;
  }

  // Persist every verdict already returned by the recent cache before a slow
  // transaction-history lookup can delay the rest of the selected batch.
  for (let i = 0; i < processingWithSig.length; i++) {
    const transfer = processingWithSig[i];
    const status = statuses[i] ?? null;
    if (status && !(await applyOnChainVerdict(env, repo, transfer, status, nowIso))) {
      const reason = unresolvedReasonForStatus(status);
      if (reason === "processed_only" && !hasSignedSubmission(transfer)) continue;
      await keepStartedSubmissionForReconciliation(repo, transfer, nowIso, reason);
    }
  }

  const cacheMisses = processingWithSig.filter((_transfer, index) => !statuses[index]);
  const now = new Date();
  const expiredLegacyTransfers = cacheMisses.filter(
    (transfer) =>
      !hasSignedSubmission(transfer) &&
      now.getTime() - new Date(transfer.updated_at).getTime() > STUCK_PROCESSING_AFTER_MS
  );
  await reconcileExpiredLegacyCacheMisses(env, repo, rpc, expiredLegacyTransfers, nowIso);

  await reconcileSignedSubmissionCacheMisses(
    env,
    repo,
    rpc,
    cacheMisses.filter(hasSignedSubmission),
    nowIso
  );
}

/**
 * Resolves expired signature-bearing rows without a signed submission from
 * transaction history: the recent-status cache alone cannot distinguish a
 * dropped transaction from one that landed and aged out of the cache.
 */
async function reconcileExpiredLegacyCacheMisses(
  env: Env,
  repo: PaymentsRepository,
  rpc: SolanaRpc,
  transfers: PaymentTransferWithSignature[],
  nowIso: string
): Promise<void> {
  if (transfers.length === 0) return;

  const archived = await getArchivedStatuses(rpc, transfers);
  if (archived === null) {
    for (const transfer of transfers) {
      await keepStartedSubmissionForReconciliation(repo, transfer, nowIso, "history_unavailable");
    }
    return;
  }

  for (let i = 0; i < transfers.length; i++) {
    const transfer = transfers[i];
    const status = archived[i] ?? null;
    if (!(await applyOnChainVerdict(env, repo, transfer, status, nowIso))) {
      if (status && unresolvedReasonForStatus(status) === "processed_only") continue;
      await keepStartedSubmissionForReconciliation(repo, transfer, nowIso, "verdict_write_failed");
    }
  }
}

async function reconcileSignedSubmissionCacheMisses(
  env: Env,
  repo: PaymentsRepository,
  rpc: SolanaRpc,
  signedSubmissions: PaymentTransferWithSignedSubmission[],
  nowIso: string
): Promise<void> {
  if (signedSubmissions.length === 0) return;

  let currentBlockHeight: bigint | null = null;
  try {
    currentBlockHeight = await withTransientRpcRetry(() =>
      rpc.getBlockHeight({ commitment: "confirmed" }).send()
    );
  } catch (err) {
    getLogger().error(
      {
        error: err instanceof Error ? err.message : String(err),
        environment: currentClusterScope().environment,
      },
      "trackPendingTransfers: getBlockHeight RPC call failed"
    );
  }

  if (currentBlockHeight === null) {
    for (const transfer of signedSubmissions) {
      await keepStartedSubmissionForReconciliation(repo, transfer, nowIso, "history_unavailable");
    }
    return;
  }

  const expiredSignedSubmissions = signedSubmissions.filter(
    (transfer) => currentBlockHeight > BigInt(transfer.last_valid_block_height)
  );

  for (const transfer of expiredSignedSubmissions) {
    if (transfer.submission_started_at === null) {
      if (!(await applyOnChainVerdict(env, repo, transfer, null, nowIso))) {
        await keepStartedSubmissionForReconciliation(
          repo,
          transfer,
          nowIso,
          "verdict_write_failed"
        );
      }
    }
  }

  const archivalCandidates = expiredSignedSubmissions.filter(
    (transfer) => transfer.submission_started_at !== null
  );

  const archived = await getArchivedStatuses(rpc, archivalCandidates);
  if (archived === null) {
    for (const transfer of archivalCandidates) {
      await keepStartedSubmissionForReconciliation(repo, transfer, nowIso, "history_unavailable");
    }
    return;
  }

  for (let i = 0; i < archivalCandidates.length; i++) {
    const transfer = archivalCandidates[i];
    const status = archived[i] ?? null;
    if (!status) {
      await keepStartedSubmissionForReconciliation(repo, transfer, nowIso, "history_absent");
    } else if (!(await applyOnChainVerdict(env, repo, transfer, status, nowIso))) {
      await keepStartedSubmissionForReconciliation(
        repo,
        transfer,
        nowIso,
        unresolvedReasonForStatus(status)
      );
    }
  }
}

function unresolvedReasonForStatus(
  status: SignatureStatusInfo
): "processed_only" | "verdict_write_failed" {
  return status.confirmationStatus !== null &&
    commitmentComparator(status.confirmationStatus, "confirmed") < 0
    ? "processed_only"
    : "verdict_write_failed";
}

function hasSignedSubmission(
  transfer: PaymentTransferWithSignature
): transfer is PaymentTransferWithSignedSubmission {
  return transfer.signed_transaction !== null && transfer.last_valid_block_height !== null;
}

/** Keep unresolved started rows visible to operators and rotate the polling queue. */
async function keepStartedSubmissionForReconciliation(
  repo: PaymentsRepository,
  transfer: PaymentTransferRow,
  nowIso: string,
  reason: "history_unavailable" | "history_absent" | "processed_only" | "verdict_write_failed"
): Promise<void> {
  try {
    const rotated = await repo.updateTransfer({
      transferId: transfer.id,
      expectedStatus: "processing",
      updatedAt: nowIso,
    });
    if (!rotated) return;
    logEvent("warn", {
      event: "sdp_api_payment_submission_unresolved",
      flow: "reconciler",
      reason,
      organization_id: transfer.organization_id,
      project_id: transfer.project_id,
      transfer_id: transfer.id,
      transfer_type: transfer.type,
      signature: transfer.signature,
      last_valid_block_height: transfer.last_valid_block_height,
      submission_started_at: transfer.submission_started_at,
    });
  } catch (err) {
    getLogger().error(
      {
        transfer_id: transfer.id,
        error: err instanceof Error ? err.message : String(err),
      },
      "trackPendingTransfers: failed to rotate unresolved submission"
    );
  }
}

async function getArchivedStatuses(
  rpc: SolanaRpc,
  transfers: PaymentTransferWithSignature[]
): Promise<Array<SignatureStatusInfo | null> | null> {
  if (transfers.length === 0) {
    return [];
  }

  try {
    const statuses = await getSignatureStatuses(
      rpc,
      transfers.map((transfer) => transfer.signature),
      { searchTransactionHistory: true }
    );
    if (statuses.length !== transfers.length) {
      throw internalError(
        `getSignatureStatuses returned ${statuses.length} statuses for ${transfers.length} signatures`
      );
    }
    return statuses;
  } catch (err) {
    getLogger().error(
      {
        error: err instanceof Error ? err.message : String(err),
        environment: currentClusterScope().environment,
      },
      "trackPendingTransfers: archival getSignatureStatuses RPC call failed"
    );
    return null;
  }
}
