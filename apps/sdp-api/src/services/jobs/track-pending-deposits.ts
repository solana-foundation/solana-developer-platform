/**
 * Background Job: Track Pending Private Channel Deposits
 *
 * State machine: pending → submitted → confirmed (terminal, best-effort) | failed.
 *
 * Reconciles non-terminal deposits each cron tick:
 *  1. `pending` with no signature, stuck > 5 min → failed (never broadcast).
 *  2. `submitted` with a signature → getSignatureStatuses on the cluster scope's
 *     managed RPC → `confirmed` / `failed`; signature not found + stale → failed.
 *     Status reads are batched per tick: every submitted signature rides a single
 *     getSignatureStatuses call instead of one RPC round trip per row.
 *
 * `confirmed → settled` is not driven: the operator's channel-side credit is
 * off-chain and gateway `getTransaction` is Operator-only, so we can't observe
 * it. The UI surfaces the credit via the channel-balance read.
 *
 * Runs once per environment under that environment's cluster scope, sweeping
 * only that environment's deposits on the scope's managed RPC pool. The audit
 * context on each deposit is never consulted here.
 * All status transitions are compare-and-swap (`expectedStatus`) so a concurrent
 * worker can't regress state.
 */

import { getSignatureStatuses, type SignatureStatusInfo } from "@sdp/rpc/solana";
import { assertIsSignature, type Signature } from "@solana/kit";
import {
  createPrivateChannelDepositRepository,
  createPrivateChannelInstanceRepository,
  type PrivateChannelDepositRepository,
  type PrivateChannelDepositRow,
  type PrivateChannelInstanceRow,
} from "@/db/repositories";
import { getLogger } from "@/runtime/logger";
import { emitDepositEvent } from "@/services/private-channels/deposit-events";
import { loadProjectRpcClient } from "@/services/private-channels/project-rpc";
import type { Env } from "@/types/env";

const STUCK_AFTER_MS = 5 * 60 * 1000;
const MAX_PER_RUN = 100;

export async function trackPendingDeposits(env: Env): Promise<void> {
  const repo = createPrivateChannelDepositRepository(env);
  const instanceRepo = createPrivateChannelInstanceRepository(env);
  const pending = await repo.listNonTerminal(MAX_PER_RUN);
  if (pending.length === 0) {
    return;
  }

  // Cache instance rows across the tick — a busy project's deposits share one row
  // and we don't want to hit Postgres once per deposit.
  const instances = new Map<string, PrivateChannelInstanceRow | null>();
  const loadInstance = async (id: string) => {
    if (instances.has(id)) {
      return instances.get(id) ?? null;
    }
    const row = await instanceRepo.getById(id);
    instances.set(id, row);
    return row;
  };
  const now = Date.now();

  // Every submitted signature in the tick shares one batched
  // getSignatureStatuses call; MAX_PER_RUN keeps it under the RPC's
  // 256-signature cap.
  const submittedDeposits: SubmittedDeposit[] = [];

  const reconcileSubmitted = async (deposit: PrivateChannelDepositRow): Promise<void> => {
    const storedSignature = deposit.signature;
    if (!storedSignature) {
      await failIfStale(env, repo, deposit, now, "Deposit was submitted without a signature.");
      return;
    }
    assertIsSignature(storedSignature);
    submittedDeposits.push({ deposit, signature: storedSignature });
  };

  // Pass 1 — local transitions (stale fails, CAS promotions) and bucketing; no
  // per-row RPC.
  for (const deposit of pending) {
    try {
      if (deposit.status === "pending" && !deposit.signature) {
        await failIfStale(env, repo, deposit, now, "Deposit was never broadcast.");
      } else if (deposit.status === "pending") {
        // The signature is persisted before the send, so a pending row that
        // carries one belongs to a request that died mid-send: the transaction
        // may be on chain. Promote it and let the submitted reconciliation ask
        // the chain, instead of failing a deposit that may have executed.
        if (now - Date.parse(deposit.updated_at) <= STUCK_AFTER_MS) {
          continue;
        }
        const promoted = await repo.updateDeposit({
          id: deposit.id,
          status: "submitted",
          expectedStatus: "pending",
        });
        if (promoted) {
          const instance = await loadInstance(promoted.instance_id);
          if (instance) {
            await reconcileSubmitted(promoted);
          }
        }
      } else if (deposit.status === "submitted") {
        const instance = await loadInstance(deposit.instance_id);
        if (!instance) {
          // Instance is gone — nothing to reconcile against. Deposits without an
          // instance are stuck by definition; auto-fail once past the stale
          // window so a brief reconnect gap doesn't kill in-flight rows. Unlike
          // failIfStale this path is signature-agnostic — there's no chain we
          // can query, signed or not.
          await failStale(env, repo, deposit, now, "Deposit instance no longer connected.");
          continue;
        }
        await reconcileSubmitted(deposit);
      }
      // `confirmed` intentionally has no transition here — see module docstring.
    } catch (err) {
      logReconcileError(deposit.id, deposit.status, err);
    }
  }

  // Pass 2 — one batched status read on the scope's RPC, then per-row verdicts.
  await reconcileSubmittedBatch(env, repo, submittedDeposits, now);
}

/** A submitted deposit with its validated signature. */
interface SubmittedDeposit {
  deposit: PrivateChannelDepositRow;
  signature: Signature;
}

/**
 * Read every submitted deposit's status in one batched call on the open cluster scope's managed
 * RPC pool, then apply each verdict. A failed or mismatched batch is logged and left for the next tick.
 *
 * @param env - Process env for the repository and event writes.
 * @param repo - The deposit repository the verdicts are written through.
 * @param submittedDeposits - The tick's submitted deposits with their signatures.
 * @param now - The tick's clock, for the stale-not-found verdict.
 * @returns Resolves once every verdict is applied or logged.
 * @throws SdpRpcError `CLUSTER_SCOPE_MISSING` outside a cluster scope.
 */
async function reconcileSubmittedBatch(
  env: Env,
  repo: PrivateChannelDepositRepository,
  submittedDeposits: SubmittedDeposit[],
  now: number
): Promise<void> {
  if (submittedDeposits.length === 0) {
    return;
  }
  const { rpc } = loadProjectRpcClient();
  let statuses: Array<SignatureStatusInfo | null>;
  try {
    // searchTransactionHistory because every caller of this is already past the
    // node's short recent-status cache: a submitted row is only polled on the
    // reconciler's cadence, and the signed-pending promotion reaches here
    // strictly AFTER STUCK_AFTER_MS. Without it an executed deposit reads null,
    // gets failed as "not found on chain", and the dashboard hands the caller a
    // fresh idempotency key for a deposit that already moved funds.
    statuses = await getSignatureStatuses(
      rpc,
      submittedDeposits.map((submitted) => submitted.signature),
      { searchTransactionHistory: true }
    );
  } catch (err) {
    getLogger().error(
      {
        deposits: submittedDeposits.length,
        error: err instanceof Error ? err.message : String(err),
      },
      "trackPendingDeposits: batched getSignatureStatuses failed"
    );
    return;
  }
  if (statuses.length !== submittedDeposits.length) {
    getLogger().error(
      { deposits: submittedDeposits.length, statuses: statuses.length },
      "trackPendingDeposits: getSignatureStatuses returned a mismatched batch"
    );
    return;
  }
  for (const [index, { deposit }] of submittedDeposits.entries()) {
    try {
      await applySubmittedVerdict(env, repo, deposit, statuses[index] ?? null, now);
    } catch (err) {
      logReconcileError(deposit.id, "submitted", err);
    }
  }
}

function logReconcileError(depositId: string, status: string, err: unknown): void {
  getLogger().error(
    {
      depositId,
      status,
      error: err instanceof Error ? err.message : String(err),
    },
    "trackPendingDeposits: failed to reconcile deposit"
  );
}

/** Fail a signature-less deposit that has been stuck past the threshold. */
async function failIfStale(
  env: Env,
  repo: PrivateChannelDepositRepository,
  deposit: PrivateChannelDepositRow,
  now: number,
  reason: string
): Promise<void> {
  if (deposit.signature) {
    return;
  }
  await failStale(env, repo, deposit, now, reason, { expectedSignatureAbsent: true });
}

/** Signature-agnostic stale fail. */
async function failStale(
  env: Env,
  repo: PrivateChannelDepositRepository,
  deposit: PrivateChannelDepositRow,
  now: number,
  reason: string,
  guard: { expectedSignatureAbsent?: boolean } = {}
): Promise<void> {
  if (now - Date.parse(deposit.updated_at) <= STUCK_AFTER_MS) {
    return;
  }
  const failed = await repo.updateDeposit({
    id: deposit.id,
    status: "failed",
    expectedSignatureAbsent: guard.expectedSignatureAbsent ?? false,
    failureReason: reason,
    expectedStatus: deposit.status,
  });
  if (failed) {
    await emitDepositEvent(env, failed, "transfer.deposit.failed", "failed", {
      failureReason: reason,
    });
  }
}

/** submitted → confirmed/failed by applying an already-fetched signature status. */
async function applySubmittedVerdict(
  env: Env,
  repo: PrivateChannelDepositRepository,
  deposit: PrivateChannelDepositRow,
  status: SignatureStatusInfo | null,
  now: number
): Promise<void> {
  if (!status) {
    // Not found on chain; if it's been a while, treat the tx as dropped.
    if (now - Date.parse(deposit.updated_at) > STUCK_AFTER_MS) {
      const reason = "Deposit transaction not found on chain.";
      const failed = await repo.updateDeposit({
        id: deposit.id,
        status: "failed",
        failureReason: reason,
        expectedStatus: "submitted",
      });
      if (failed) {
        await emitDepositEvent(env, failed, "transfer.deposit.failed", "failed", {
          failureReason: reason,
        });
      }
    }
    return;
  }

  if (status.err) {
    const reason = JSON.stringify(status.err);
    const failed = await repo.updateDeposit({
      id: deposit.id,
      status: "failed",
      failureReason: reason,
      expectedStatus: "submitted",
    });
    if (failed) {
      await emitDepositEvent(env, failed, "transfer.deposit.failed", "failed", {
        failureReason: reason,
      });
    }
    return;
  }

  if (status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized") {
    const confirmed = await repo.updateDeposit({
      id: deposit.id,
      status: "confirmed",
      expectedStatus: "submitted",
    });
    if (confirmed) {
      await emitDepositEvent(env, confirmed, "transfer.deposit.confirmed", "confirmed", {
        signature: deposit.signature,
      });
    }
  }
}
