/**
 * Background Job: Track Pending Transfers
 *
 * Runs on a Cloudflare Workers cron schedule to reconcile transfer statuses:
 *
 * 1. Recover stuck "processing" transfers with no signature — created by
 *    executeTransfer but the worker may have crashed before receiving a signature.
 *    Mark them failed after 5 minutes.
 *
 * 2. Sync on-chain status for "processing" transfers that do have a signature —
 *    these are submitted transactions whose final confirmation may not have been
 *    recorded due to a timeout or worker crash. We batch-check their statuses via
 *    getSignatureStatuses and update DB accordingly.
 */

import type { Signature } from "@solana/kit";
import {
  createPaymentsRepository,
  type PaymentsRepository,
  WALLET_TRANSFER_TYPES,
} from "@/db/repositories";
import type { SignatureStatusInfo } from "@/services/solana/rpc";
import * as solanaRpc from "@/services/solana/rpc";
import type { Env } from "@/types/env";

// Allow 5 minutes before treating a signature-less "processing" transfer as stuck.
const STUCK_PROCESSING_AFTER_MS = 5 * 60 * 1000;
// getSignatureStatuses accepts at most 256 signatures per call.
const MAX_SIGNATURES_PER_BATCH = 256;

export async function trackPendingTransfers(env: Env): Promise<void> {
  const repo = createPaymentsRepository(env);
  const now = new Date();
  const nowIso = now.toISOString();

  await recoverStuckProcessingTransfers(repo, now, nowIso);
  await syncProcessingTransfersOnChain(env, repo, nowIso);
}

/**
 * Fail processing transfers that have no signature and have been stuck for
 * longer than the recovery threshold, indicating the worker crashed before
 * obtaining a signature.
 */
async function recoverStuckProcessingTransfers(
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
      await repo.updateTransfer({
        transferId: transfer.id,
        status: "failed",
        error: "Transfer processing timed out",
        updatedAt: nowIso,
      });
    } catch (err) {
      console.error("trackPendingTransfers: failed to recover stuck processing transfer", {
        transferId: transfer.id,
        error: err instanceof Error ? err.message : String(err),
      });
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

  const signatures = processingWithSig
    .map((t) => t.signature)
    .filter((s): s is string => s !== null) as Signature[];

  let statuses: Array<SignatureStatusInfo | null>;

  try {
    const rpc = solanaRpc.createRpc(env);
    statuses = await solanaRpc.getSignatureStatuses(rpc, signatures);
  } catch (err) {
    console.error("trackPendingTransfers: getSignatureStatuses RPC call failed", {
      error: err instanceof Error ? err.message : String(err),
    });
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
          await repo.updateTransfer({
            transferId: transfer.id,
            status: "failed",
            error: "Transaction not found on chain",
            updatedAt: nowIso,
          });
        }
        continue;
      }

      if (status.err) {
        await repo.updateTransfer({
          transferId: transfer.id,
          status: "failed",
          slot: Number(status.slot),
          error: JSON.stringify(status.err),
          updatedAt: nowIso,
        });
        continue;
      }

      if (status.confirmationStatus === "finalized") {
        await repo.updateTransfer({
          transferId: transfer.id,
          status: "finalized",
          slot: Number(status.slot),
          updatedAt: nowIso,
        });
      } else if (status.confirmationStatus === "confirmed") {
        await repo.updateTransfer({
          transferId: transfer.id,
          status: "confirmed",
          slot: Number(status.slot),
          updatedAt: nowIso,
        });
      }
      // "processed" confirmation is too weak to record as confirmed — skip.
    } catch (err) {
      console.error("trackPendingTransfers: failed to update transfer", {
        transferId: transfer.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
