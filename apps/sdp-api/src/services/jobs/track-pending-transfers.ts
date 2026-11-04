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

import {
  createClusterRpc,
  type EndpointHistoryFailure,
  type EveryEndpointSignatureStatus,
  getSignatureStatusesFromEveryEndpoint,
} from "@sdp/rpc/factory";
import { currentClusterScope } from "@sdp/rpc/scope";
import type { SignatureStatusInfo, SolanaRpc } from "@sdp/rpc/solana";
import {
  getChainHeight,
  getSignatureStatuses,
  VERDICT_HISTORY_HORIZON_BLOCKS,
} from "@sdp/rpc/solana";
import { withTransientRpcRetry } from "@sdp/rpc/transient";
import type { TransferChainVerdictStatus } from "@sdp/types/payments";
import { WALLET_TRANSFER_TYPES } from "@sdp/types/payments";
import { assertIsSignature, commitmentComparator, type Signature, type Slot } from "@solana/kit";
import {
  TRANSFER_BATCH_ATTEMPT_LIFETIME_MS,
  transferBatchChunkAuditIntentId,
} from "@/db/repositories/payment-transfer-batches.repository";
import { createPostgresPaymentTransferBatchesRepository } from "@/db/repositories/payment-transfer-batches.repository.postgres";
import type {
  ConfirmedTransferPollVerdict,
  PaymentsRepository,
  PaymentTransferRow,
  SignedSubmissionTransferRow,
  UpdatePaymentTransferInput,
} from "@/db/repositories/payments.repository";
import {
  createSystemPaymentsRepository,
  createSystemPaymentTransferBatchesRepository,
  createSystemTransactionalPaymentsRepository,
} from "@/db/repositories/repository-factory";
import { mapSettledWithConcurrency } from "@/lib/concurrency";
import { internalError } from "@/lib/errors";
import { getLogger } from "@/runtime/logger";
import { logEvent } from "@/runtime/money-path-events";
import {
  type AuditLogEntry,
  createSystemAuditService,
  criticalOutcomeEntry,
} from "@/services/audit.service";
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
type WithSignature<T extends PaymentTransferRow> = T & { signature: Signature };
type PaymentTransferWithSignedSubmission = WithSignature<SignedSubmissionTransferRow>;

type FinalizedHeight = Awaited<ReturnType<typeof getChainHeight>>;

/** What proves a processing row's transaction never landed. */
type NotLandedProof = "broadcast_never_started" | "expired_unseen";

/** Why a processing row keeps its status this pass. */
type UnresolvedVerdict =
  | {
      reason:
        | "history_unavailable"
        | "processed_only"
        | "error_unfinalized"
        | "verdict_write_failed";
    }
  | { reason: "node_behind_floor"; contextSlot: string; minContextSlot: string };

function hasValidStoredSignature<T extends PaymentTransferRow>(
  transfer: T
): transfer is WithSignature<T> {
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

function partitionByValidStoredSignature<T extends PaymentTransferRow>(transfers: T[]) {
  const valid: WithSignature<T>[] = [];
  const invalid: T[] = [];
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
 * no-op-on-conflict semantics; one whose request left its audit intent open
 * commits that intent's outcome with the update.
 *
 * @param env - Process environment.
 * @param repo - System payments repository.
 * @param transfer - The processing transfer to settle.
 * @param input - The terminal status and the fields and guards it is written with.
 * @returns True when this call wrote the row; false when its guards matched nothing (a concurrent
 * settle, or a start marker the input requires absent).
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
): Promise<boolean> {
  if (transfer.type === "transfer_batch") {
    if (transfer.project_id === null) {
      throw internalError("Transfer batch transfer is missing a project");
    }
    const projectId = transfer.project_id;
    // The settle and the audit outcome it implies commit together: a ledger
    // failure rolls the settle back, so the chunk stays processing and the next
    // run settles and audits it again (APE-425).
    return createSystemAuditService(env).logSystemWithin(async (tx) => {
      const settled = await createPostgresPaymentTransferBatchesRepository(tx).settleTransferBatch({
        transferId: transfer.id,
        requireUnsigned: input.requireUnsigned,
        organizationId: transfer.organization_id,
        projectId,
        transferStatus: input.status,
        error: input.status === "failed" ? input.error : null,
        slot: input.slot === undefined ? null : input.slot,
        updatedAt: input.updatedAt,
        requireUnstarted: input.requireUnstarted,
      });
      return { entry: settled ? chunkAuditOutcome(transfer, input) : null, result: settled };
    });
  }
  const auditIntentId = transfer.audit_intent_id;
  if (auditIntentId === null) {
    return (await repo.updateTransfer({ ...input, expectedStatus: "processing" })) !== null;
  }
  // A request whose submission was ambiguous left its intent open; the settle
  // closes it in the same transaction, so a ledger failure leaves the row
  // processing for the next run (HOO-2556). Clearing the row's open intent is
  // the claim: a request that closed it first leaves nothing to append.
  return createSystemAuditService(env).logSystemWithin(async (tx) => {
    const payments = createSystemTransactionalPaymentsRepository(tx);
    const settled =
      (await payments.updateTransfer({ ...input, expectedStatus: "processing" })) !== null;
    const claimed =
      settled &&
      (await payments.closeTransferAuditIntent({
        transferId: transfer.id,
        organizationId: transfer.organization_id,
        projectId: transfer.project_id,
        auditIntentId,
      }));
    return {
      entry: claimed ? transferAuditOutcome(transfer, auditIntentId, input) : null,
      result: settled,
    };
  });
}

/**
 * The audit outcome that closes the intent the sending request recorded on the
 * row, with the chain verdict the job observed.
 */
function transferAuditOutcome(
  transfer: PaymentTransferRow,
  auditIntentId: string,
  input: { status: TransferChainVerdictStatus; slot?: number | null; error?: string | null }
): AuditLogEntry {
  const metadata: Record<string, unknown> = {
    status: input.status,
    signature: transfer.signature,
    slot: input.slot === undefined || input.slot === null ? null : String(input.slot),
  };
  if (input.status === "failed") metadata.error = input.error;
  return criticalOutcomeEntry(
    {
      id: auditIntentId,
      entry: {
        organizationId: transfer.organization_id,
        action: "transfer",
        resourceType: "payment_transfer",
        resourceId: transfer.id,
      },
    },
    { status: input.status === "failed" ? "failure" : "success", metadata }
  );
}

/**
 * The audit outcome that closes a settled batch chunk's intent with its chain
 * verdict (APE-425). The request that sent the chunk wrote the intent under an
 * id derived from the transfer, so the job needs no ledger lookup to close it.
 */
function chunkAuditOutcome(
  transfer: PaymentTransferRow,
  input: { status: TransferChainVerdictStatus; slot?: number | null; error?: string | null }
): AuditLogEntry {
  const metadata: Record<string, unknown> = {
    batchTransferStatus: input.status,
    signature: transfer.signature,
    slot: input.slot === undefined || input.slot === null ? null : String(input.slot),
  };
  if (input.status === "failed") metadata.error = input.error;
  return criticalOutcomeEntry(
    {
      id: transferBatchChunkAuditIntentId(transfer.id),
      entry: {
        organizationId: transfer.organization_id,
        action: "transfer",
        resourceType: "payment_transfer",
        resourceId: transfer.id,
      },
    },
    { status: input.status === "failed" ? "failure" : "success", metadata }
  );
}

/**
 * Applies an observed on-chain status to one processing transfer. A success settles at the
 * commitment observed (`confirmed` or `finalized`); an on-chain error is terminal only at
 * `finalized`.
 *
 * @param env - Process environment.
 * @param repo - System payments repository.
 * @param transfer - The processing transfer the status belongs to.
 * @param status - The transaction's status as a node reported it.
 * @param nowIso - Timestamp applied to the settled row.
 * @returns True when the status settled the row (a lost CAS is a no-op, not an error); false
 * when the status settles nothing yet or the write failed.
 */
async function applyOnChainVerdict(
  env: Env,
  repo: PaymentsRepository,
  transfer: PaymentTransferRow,
  status: SignatureStatusInfo,
  nowIso: string
): Promise<boolean> {
  // An error seen only at "processed" may be on a fork the cluster drops, and
  // the same signed transaction can still land; failing the row here would
  // let a retry pay twice (APE SOLA9-708). A confirmed block can still be
  // rolled back, so an error is final only once finalized.
  const committed =
    status.confirmationStatus !== null &&
    commitmentComparator(status.confirmationStatus, "confirmed") >= 0;
  const finalized =
    status.confirmationStatus !== null &&
    commitmentComparator(status.confirmationStatus, "finalized") >= 0;
  if (!committed || (status.err && !finalized)) {
    return false;
  }

  try {
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

    await updateTerminalTransfer(env, repo, transfer, {
      transferId: transfer.id,
      status: finalized ? "finalized" : "confirmed",
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

/**
 * Fails a processing transfer whose transaction provably never landed. A row that never started
 * broadcast fails only while SQL still shows it unstarted (`requireUnstarted`), so a request that
 * starts the send concurrently wins. A row whose expiry the finalized height proved, and whose
 * signature is absent from history read at the finalized slot, fails from processing whatever its
 * start marker says.
 *
 * @param env - Process environment.
 * @param repo - System payments repository.
 * @param transfer - The processing transfer to fail.
 * @param proof - What proves the transaction never landed.
 * @param nowIso - Timestamp applied to the failed row.
 * @returns `written` when this call failed the row, `lost_race` when its guards matched nothing
 * (a concurrent settle or send start), and `errored` when the write threw.
 */
async function failNotLanded(
  env: Env,
  repo: PaymentsRepository,
  transfer: PaymentTransferRow,
  proof: NotLandedProof,
  nowIso: string
): Promise<"written" | "lost_race" | "errored"> {
  try {
    const written = await updateTerminalTransfer(env, repo, transfer, {
      transferId: transfer.id,
      status: "failed",
      error: "Transaction not found on chain",
      updatedAt: nowIso,
      requireUnstarted: proof === "broadcast_never_started" ? true : undefined,
    });
    return written ? "written" : "lost_race";
  } catch (err) {
    getLogger().error(
      {
        transfer_id: transfer.id,
        error: err instanceof Error ? err.message : String(err),
      },
      "trackPendingTransfers: failed to update transfer"
    );
    return "errored";
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

const STRANDED_BATCH_PAGE_SIZE = 50;

/**
 * Settles batches whose request died after the batch and its recipients
 * committed but before a chunk transfer was written (HOO-1918). Those
 * recipients were never sent (a chunk's transfer row and links commit before
 * its broadcast), and no transfer row exists for the sweep above to settle, so
 * without a same-key retry the batch would stay processing forever. They are
 * failed and the batch status recomputed, as the record finder does on a retry.
 *
 * An unsent recipient is stranded once the chain passes the lastValidBlockHeight
 * of the attempt that wrote or claimed it: every chunk of that attempt shares
 * one blockhash, so nothing it built can land any more (HOO-2343). The block
 * height is read only when some unsent recipient records a height. A recipient
 * with none, or a block height the RPC can't give, falls back to the hour.
 * Either way the chunk link's compare-and-swap makes failing a recipient safe:
 * a chunk links only recipients still unsent, so it is failed or sent, never
 * both.
 */
async function failStrandedTransferBatches(env: Env, now: Date): Promise<void> {
  const batches = createSystemPaymentTransferBatchesRepository(env);
  const environment = currentClusterScope().environment;
  // Aged by each recipient's last write, so a retry that just claimed
  // recipients of an old batch is never failed under it (HOO-2343).
  const attemptedBefore = new Date(
    now.getTime() - TRANSFER_BATCH_ATTEMPT_LIFETIME_MS
  ).toISOString();
  const expiredBelowBlockHeight = await blockHeightPastAnUnsentAttempt(batches);
  const cutoff =
    expiredBelowBlockHeight === null
      ? { attemptedBefore }
      : { attemptedBefore, expiredBelowBlockHeight };
  const stranded = await batches.listStrandedTransferBatches({
    environment,
    limit: STRANDED_BATCH_PAGE_SIZE,
    ...cutoff,
  });
  for (const batch of stranded) {
    await batches.failUnsentTransferRecipients({
      ...batch,
      error: "The batch request ended before this recipient's transfer was sent",
      ...cutoff,
    });
  }
}

/**
 * The cluster's current block height, when an unsent batch recipient records
 * an attempt height it may have passed; otherwise null, without an RPC call.
 */
async function blockHeightPastAnUnsentAttempt(
  batches: ReturnType<typeof createSystemPaymentTransferBatchesRepository>
): Promise<bigint | null> {
  const { environment } = currentClusterScope();
  const lowest = await batches.lowestUnsentAttemptBlockHeight({ environment });
  if (lowest === null) return null;
  try {
    const height = await withTransientRpcRetry(() =>
      createClusterRpc().getBlockHeight({ commitment: "confirmed" }).send()
    );
    return height > lowest ? height : null;
  } catch (err) {
    getLogger().error(
      { error: err instanceof Error ? err.message : String(err), environment },
      "trackPendingTransfers: getBlockHeight for stranded batches failed"
    );
    return null;
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
    unsigned: true,
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
    await repo.listProcessingSignedSubmissions({
      environment: currentClusterScope().environment,
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
    const status = statuses[i];
    if (status && !(await applyOnChainVerdict(env, repo, transfer, status, nowIso))) {
      await keepStartedSubmissionForReconciliation(repo, transfer, nowIso, {
        reason: unresolvedReasonForStatus(status),
      });
    }
  }

  await reconcileCacheMisses(
    env,
    repo,
    rpc,
    processingWithSig.filter((_transfer, index) => !statuses[index]),
    nowIso
  );
}

/**
 * Judges the processing rows the recent-status cache did not answer. The `finalized` block height
 * proves a signed row's blockhash expired: every later block descends from one that can no longer
 * include it. Every row that may have been broadcast is then re-read from transaction history on
 * every pool endpoint at the finalized slot (`minContextSlot` against the `finalized` bank, with
 * SDP's own `context.slot` check), so neither a node behind that proof nor one endpoint's missing
 * history can report a landed transaction absent. An endpoint that cannot answer is a miss: no
 * verdict this pass. A null from every endpoint fails the row only while its landing window is
 * inside the history horizon; past it the row stays processing and alerts.
 *
 * @param env - Process environment.
 * @param repo - System payments repository.
 * @param rpc - The pass's pool client.
 * @param signed - The cache misses, each with saved signed bytes and a last valid block height.
 * @param nowIso - Timestamp applied to every written row.
 * @returns Resolves once every row is settled or rotated.
 */
async function reconcileCacheMisses(
  env: Env,
  repo: PaymentsRepository,
  rpc: SolanaRpc,
  signed: PaymentTransferWithSignedSubmission[],
  nowIso: string
): Promise<void> {
  if (signed.length === 0) return;

  let finalized: FinalizedHeight;
  try {
    finalized = await withTransientRpcRetry(() => getChainHeight(rpc, "finalized"));
  } catch (err) {
    getLogger().error(
      {
        error: err instanceof Error ? err.message : String(err),
        environment: currentClusterScope().environment,
      },
      "trackPendingTransfers: finalized getEpochInfo RPC call failed"
    );
    for (const transfer of signed) {
      await keepStartedSubmissionForReconciliation(repo, transfer, nowIso, {
        reason: "history_unavailable",
      });
    }
    return;
  }

  const expiredSigned = signed.filter(
    (transfer) => finalized.blockHeight > BigInt(transfer.last_valid_block_height)
  );
  for (const transfer of expiredSigned) {
    if (
      transfer.submission_started_at === null &&
      (await failNotLanded(env, repo, transfer, "broadcast_never_started", nowIso)) === "errored"
    ) {
      await keepStartedSubmissionForReconciliation(repo, transfer, nowIso, {
        reason: "verdict_write_failed",
      });
    }
  }

  const candidates = expiredSigned.filter((transfer) => transfer.submission_started_at !== null);
  if (candidates.length === 0) return;

  const history = await getSignatureStatusesFromEveryEndpoint(
    candidates.map((transfer) => transfer.signature),
    { minContextSlot: finalized.absoluteSlot, commitment: "finalized" }
  );
  const unresolvedRead = history.find(
    (read): read is Extract<EveryEndpointSignatureStatus, { kind: "unresolved" }> =>
      read.kind === "unresolved"
  );
  if (unresolvedRead !== undefined) {
    logUnavailableHistory(unresolvedRead.failures);
  }

  for (const [index, transfer] of candidates.entries()) {
    const read = history[index];
    if (read.kind === "unresolved") {
      await keepStartedSubmissionForReconciliation(
        repo,
        transfer,
        nowIso,
        unresolvedHistoryVerdict(read.failures, finalized.absoluteSlot)
      );
      continue;
    }
    await settleFromHistory(env, repo, transfer, read.kind === "found" ? read.status : null, {
      finalized,
      nowIso,
    });
  }
}

function unresolvedHistoryVerdict(
  failures: readonly EndpointHistoryFailure[],
  minContextSlot: Slot
): UnresolvedVerdict {
  const lags = failures.flatMap((failure) =>
    failure.reason === "node_behind_floor" ? [failure] : []
  );
  const [firstLag] = lags;
  if (firstLag === undefined || lags.length < failures.length) {
    return { reason: "history_unavailable" };
  }
  return {
    reason: "node_behind_floor",
    contextSlot: firstLag.contextSlot.toString(),
    minContextSlot: minContextSlot.toString(),
  };
}

function logUnavailableHistory(failures: readonly EndpointHistoryFailure[]): void {
  for (const failure of failures) {
    if (failure.reason !== "history_unavailable") continue;
    getLogger().error(
      {
        error: failure.errorMessage,
        environment: currentClusterScope().environment,
      },
      "trackPendingTransfers: archival getSignatureStatuses RPC call failed"
    );
  }
}

/**
 * Settles one row from its history status read at the finalized floor: a status applies as an
 * on-chain verdict; a null from every endpoint fails the row inside the history horizon and alerts
 * past it.
 *
 * @param env - Process environment.
 * @param repo - System payments repository.
 * @param transfer - A signed row that started broadcast and expired.
 * @param status - Its status from any endpoint, or null when every endpoint at the floor has none.
 * @param pass - The pass's proof and timestamp.
 * @param pass.finalized - The finalized height that proved the expiry and floored the read.
 * @param pass.nowIso - Timestamp applied to the written row.
 * @returns Resolves once the row is settled or rotated.
 */
async function settleFromHistory(
  env: Env,
  repo: PaymentsRepository,
  transfer: PaymentTransferWithSignedSubmission,
  status: SignatureStatusInfo | null,
  pass: { finalized: FinalizedHeight; nowIso: string }
): Promise<void> {
  const { finalized, nowIso } = pass;
  if (status !== null) {
    if (!(await applyOnChainVerdict(env, repo, transfer, status, nowIso))) {
      await keepStartedSubmissionForReconciliation(repo, transfer, nowIso, {
        reason: unresolvedReasonForStatus(status),
      });
    }
    return;
  }
  if (
    finalized.blockHeight - BigInt(transfer.last_valid_block_height) >
    VERDICT_HISTORY_HORIZON_BLOCKS
  ) {
    await keepUnprovableVerdict(repo, transfer, nowIso, finalized);
    return;
  }
  const outcome = await failNotLanded(env, repo, transfer, "expired_unseen", nowIso);
  if (outcome === "errored") {
    await keepStartedSubmissionForReconciliation(repo, transfer, nowIso, {
      reason: "verdict_write_failed",
    });
    return;
  }
  if (outcome === "lost_race") return;
  logEvent("warn", {
    event: "sdp_api_payment_submission_not_landed",
    flow: "reconciler",
    organization_id: transfer.organization_id,
    project_id: transfer.project_id,
    transfer_id: transfer.id,
    transfer_type: transfer.type,
    signature: transfer.signature,
    last_valid_block_height: transfer.last_valid_block_height,
    submission_started_at: transfer.submission_started_at,
    finalized_block_height: finalized.blockHeight.toString(),
    min_context_slot: finalized.absoluteSlot.toString(),
  });
}

/**
 * Why an observed status settles nothing this pass.
 *
 * @param status - A status `applyOnChainVerdict` did not settle.
 * @returns `processed_only` below `confirmed`, `error_unfinalized` for an on-chain error not yet
 * finalized, and otherwise `verdict_write_failed` (the status was settleable but the write failed).
 */
function unresolvedReasonForStatus(
  status: SignatureStatusInfo
): "processed_only" | "error_unfinalized" | "verdict_write_failed" {
  if (
    status.confirmationStatus === null ||
    commitmentComparator(status.confirmationStatus, "confirmed") < 0
  ) {
    return "processed_only";
  }
  return status.err && commitmentComparator(status.confirmationStatus, "finalized") < 0
    ? "error_unfinalized"
    : "verdict_write_failed";
}

/**
 * Moves a processing row to the back of the poll queue (`updated_at`), its status unchanged.
 *
 * @param repo - System payments repository.
 * @param transfer - The row to rotate.
 * @param nowIso - The row's new `updated_at`.
 * @returns True when this pass rotated it; false when it left processing or the write failed.
 */
async function rotateProcessingTransfer(
  repo: PaymentsRepository,
  transfer: PaymentTransferRow,
  nowIso: string
): Promise<boolean> {
  try {
    const rotated = await repo.updateTransfer({
      transferId: transfer.id,
      expectedStatus: "processing",
      updatedAt: nowIso,
    });
    return rotated !== null;
  } catch (err) {
    getLogger().error(
      {
        transfer_id: transfer.id,
        error: err instanceof Error ? err.message : String(err),
      },
      "trackPendingTransfers: failed to rotate unresolved submission"
    );
    return false;
  }
}

/**
 * Keep an unresolved started row visible to operators and rotate the polling queue.
 *
 * @param repo - System payments repository.
 * @param transfer - The row this pass could not settle.
 * @param nowIso - The row's new `updated_at`.
 * @param unresolved - Why it stays processing, with the lag when a node was behind the floor.
 * @returns Resolves once the row is rotated and logged.
 */
async function keepStartedSubmissionForReconciliation(
  repo: PaymentsRepository,
  transfer: PaymentTransferRow,
  nowIso: string,
  unresolved: UnresolvedVerdict
): Promise<void> {
  if (!(await rotateProcessingTransfer(repo, transfer, nowIso))) return;
  logEvent("warn", {
    event: "sdp_api_payment_submission_unresolved",
    flow: "reconciler",
    reason: unresolved.reason,
    organization_id: transfer.organization_id,
    project_id: transfer.project_id,
    transfer_id: transfer.id,
    transfer_type: transfer.type,
    signature: transfer.signature,
    last_valid_block_height: transfer.last_valid_block_height,
    submission_started_at: transfer.submission_started_at,
    context_slot: unresolved.reason === "node_behind_floor" ? unresolved.contextSlot : null,
    min_context_slot: unresolved.reason === "node_behind_floor" ? unresolved.minContextSlot : null,
  });
}

/**
 * Keep a row whose history read came back null past the history horizon: absence there no longer
 * proves the transaction never landed, so the row stays processing, rotates, and raises
 * `sdp_api_payment_verdict_unprovable` for an operator.
 *
 * @param repo - System payments repository.
 * @param transfer - The row whose verdict is unprovable.
 * @param nowIso - The row's new `updated_at`.
 * @param finalized - The finalized height the history read was floored at.
 * @returns Resolves once the row is rotated and the alert logged.
 */
async function keepUnprovableVerdict(
  repo: PaymentsRepository,
  transfer: PaymentTransferWithSignedSubmission,
  nowIso: string,
  finalized: FinalizedHeight
): Promise<void> {
  if (!(await rotateProcessingTransfer(repo, transfer, nowIso))) return;
  logEvent("error", {
    event: "sdp_api_payment_verdict_unprovable",
    flow: "reconciler",
    organization_id: transfer.organization_id,
    project_id: transfer.project_id,
    transfer_id: transfer.id,
    transfer_type: transfer.type,
    signature: transfer.signature,
    last_valid_block_height: transfer.last_valid_block_height,
    submission_started_at: transfer.submission_started_at,
    finalized_block_height: finalized.blockHeight.toString(),
    min_context_slot: finalized.absoluteSlot.toString(),
  });
}
