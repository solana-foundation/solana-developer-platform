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
 */

import type { SignatureStatusInfo } from "@sdp/rpc/solana";
import * as solanaRpc from "@sdp/rpc/solana";
import type { Signature } from "@solana/kit";
import {
  createSystemPaymentsRepository,
  createSystemPaymentTransferBatchesRepository,
  type PaymentsRepository,
  WALLET_TRANSFER_TYPES,
} from "@/db/repositories";
import type {
  ConfirmedTransferPollVerdict,
  PaymentTransferRow,
  UpdatePaymentTransferInput,
} from "@/db/repositories/payments.repository";
import { internalError } from "@/lib/errors";
import { getLogger } from "@/runtime/logger";
import type { Env } from "@/types/env";

// Allow 5 minutes before treating a signature-less "processing" transfer as stuck.
const STUCK_PROCESSING_AFTER_MS = 5 * 60 * 1000;
// getSignatureStatuses accepts at most 256 signatures per call.
const MAX_SIGNATURES_PER_BATCH = 256;
// A confirmed transaction finalizes within ~30s or never (fork, ledger reset);
// past this window (anchored on confirmed_at, which never moves once set) a
// still-confirmed row ages out of the finalization poll and rests at
// confirmed instead of costing an RPC history search forever.
const CONFIRMED_FINALIZATION_WINDOW_MS = 24 * 60 * 60 * 1000;

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
    ({ status: "confirmed" | "finalized" } | { status: "failed"; error: string })
): Promise<void> {
  if (transfer.type === "transfer_batch") {
    if (transfer.project_id === null) {
      throw internalError("Transfer batch transfer is missing a project");
    }
    await createSystemPaymentTransferBatchesRepository(env).settleTransferBatch({
      transferId: transfer.id,
      organizationId: transfer.organization_id,
      projectId: transfer.project_id,
      transferStatus: input.status,
      error: input.status === "failed" ? input.error : null,
      slot: input.slot === undefined ? null : input.slot,
      updatedAt: input.updatedAt,
    });
    return;
  }
  await repo.updateTransfer({ ...input, expectedStatus: "processing" });
}

export async function trackPendingTransfers(env: Env): Promise<void> {
  const repo = createSystemPaymentsRepository(env);
  const now = new Date();
  const nowIso = now.toISOString();

  await recoverStuckProcessingTransfers(env, repo, now, nowIso);
  await syncProcessingTransfersOnChain(env, repo, nowIso);
  await finalizeConfirmedTransfers(env, repo, now, nowIso);
}

/**
 * Upgrades confirmed transfers to finalized once the cluster reports finality.
 *
 * Upgrade-only by design: a confirmed transfer whose status reads null or err
 * keeps its status and rotates to the back of the poll queue — the funds were
 * already observed on chain, so this pass never introduces a new failure
 * path. Every finalized row — batch parents included — upgrades through one
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
 * @param env - Runtime environment for RPC and repository construction.
 * @param repo - System payments repository.
 * @param now - Tick time anchoring the finalization window.
 * @param nowIso - Timestamp applied to every polled row.
 * @returns Resolves when the page's poll has been recorded.
 */
async function finalizeConfirmedTransfers(
  env: Env,
  repo: PaymentsRepository,
  now: Date,
  nowIso: string
): Promise<void> {
  const windowFloor = new Date(now.getTime() - CONFIRMED_FINALIZATION_WINDOW_MS).toISOString();
  const confirmedTransfers = await repo.listConfirmedTransfersToPoll({
    confirmedAfter: windowFloor,
    limit: MAX_SIGNATURES_PER_BATCH,
  });

  if (confirmedTransfers.length === 0) {
    return;
  }

  const signatures = confirmedTransfers.map((t) => t.signature as Signature);

  let statuses: Array<SignatureStatusInfo | null>;
  try {
    const rpc = solanaRpc.createRpc(env);
    statuses = await solanaRpc.getSignatureStatuses(rpc, signatures, {
      searchTransactionHistory: true,
    });
  } catch (err) {
    getLogger().error(
      {
        error: err instanceof Error ? err.message : String(err),
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
        signature: transfer.signature as string,
      };
      return status && !status.err && status.confirmationStatus === "finalized"
        ? { ...base, finalized: true, slot: Number(status.slot) }
        : { ...base, finalized: false, slot: null };
    }
  );

  await repo.advanceConfirmedTransfers({ polled, updatedAt: nowIso });

  const finalized = polled.filter((transfer) => transfer.finalized);
  for (const transfer of finalized) {
    getLogger().info(
      {
        transfer_id: transfer.transferId,
        organization_id: transfer.organizationId,
        signature: transfer.signature,
        slot: transfer.slot,
      },
      "trackPendingTransfers: transfer finalized"
    );
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
    statuses: ["processing"],
    types: WALLET_TRANSFER_TYPES,
    hasSignature: false,
    updatedBefore: cutoff,
    limit: MAX_SIGNATURES_PER_BATCH,
  });

  for (const transfer of stuckProcessing) {
    try {
      await updateTerminalTransfer(env, repo, transfer, {
        transferId: transfer.id,
        status: "failed",
        error: "Transfer processing timed out",
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
  const processingWithSig = await repo.listTransfersByStatus({
    statuses: ["processing"],
    types: WALLET_TRANSFER_TYPES,
    hasSignature: true,
    limit: MAX_SIGNATURES_PER_BATCH,
  });

  if (processingWithSig.length === 0) {
    return;
  }

  const signatures = processingWithSig.map((t) => t.signature as Signature);

  let statuses: Array<SignatureStatusInfo | null>;

  try {
    const rpc = solanaRpc.createRpc(env);
    statuses = await solanaRpc.getSignatureStatuses(rpc, signatures);
  } catch (err) {
    getLogger().error(
      {
        error: err instanceof Error ? err.message : String(err),
      },
      "trackPendingTransfers: getSignatureStatuses RPC call failed"
    );
    return;
  }

  const now = new Date();

  for (let i = 0; i < processingWithSig.length; i++) {
    const transfer = processingWithSig[i];
    const status = statuses[i] ?? null;

    try {
      if (!status) {
        // Signature not found on chain. If the transfer has been processing long
        // enough, assume the transaction was dropped and mark it failed.
        const ageMs = now.getTime() - new Date(transfer.updated_at).getTime();
        if (ageMs > STUCK_PROCESSING_AFTER_MS) {
          await updateTerminalTransfer(env, repo, transfer, {
            transferId: transfer.id,
            status: "failed",
            error: "Transaction not found on chain",
            updatedAt: nowIso,
          });
        }
        continue;
      }

      if (status.err) {
        await updateTerminalTransfer(env, repo, transfer, {
          transferId: transfer.id,
          status: "failed",
          slot: Number(status.slot),
          error: JSON.stringify(status.err),
          updatedAt: nowIso,
        });
        continue;
      }

      if (status.confirmationStatus === "finalized") {
        await updateTerminalTransfer(env, repo, transfer, {
          transferId: transfer.id,
          status: "finalized",
          slot: Number(status.slot),
          updatedAt: nowIso,
        });
      } else if (status.confirmationStatus === "confirmed") {
        await updateTerminalTransfer(env, repo, transfer, {
          transferId: transfer.id,
          status: "confirmed",
          slot: Number(status.slot),
          updatedAt: nowIso,
        });
      }
      // "processed" confirmation is too weak to record as confirmed — skip.
    } catch (err) {
      getLogger().error(
        {
          transfer_id: transfer.id,
          error: err instanceof Error ? err.message : String(err),
        },
        "trackPendingTransfers: failed to update transfer"
      );
    }
  }
}
