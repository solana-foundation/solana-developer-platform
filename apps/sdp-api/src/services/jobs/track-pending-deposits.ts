/**
 * Background Job: Track Pending Private Channel Deposits
 *
 * State machine: pending → submitted → confirmed (terminal, best-effort) | failed.
 *
 * Reconciles non-terminal deposits each cron tick:
 *  1. `pending` with no signature, stuck > 5 min → failed (never broadcast).
 *  2. `submitted` with a signature → getSignatureStatuses on the deposit's
 *     project's configured RPC → `confirmed` / `failed`; signature not found + stale
 *     → failed.
 *
 * `confirmed → settled` is not driven: the operator's channel-side credit is
 * off-chain and gateway `getTransaction` is Operator-only, so we can't observe
 * it. The UI surfaces the credit via the channel-balance read.
 *
 * The reconciler resolves the project's CURRENT RPC connection each tick, so
 * provider changes and credential rotations apply to in-flight intents. The
 * audit context on each deposit is never consulted here.
 * All status transitions are compare-and-swap (`expectedStatus`) so a concurrent
 * worker can't regress state.
 */

import * as solanaRpc from "@sdp/rpc/solana";
import type { Signature } from "@solana/kit";
import {
  createPrivateChannelDepositRepository,
  createPrivateChannelInstanceRepository,
  type PrivateChannelDepositRepository,
  type PrivateChannelDepositRow,
  type PrivateChannelInstanceRow,
} from "@/db/repositories";
import { getLogger } from "@/runtime/logger";
import { emitDepositEvent } from "@/services/private-channels/deposit-events";
import {
  loadProjectRpcClient,
  type PrivateChannelProjectRpcClient,
} from "@/services/private-channels/project-rpc";
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
  const projectRpcs = new Map<string, Promise<PrivateChannelProjectRpcClient>>();
  const loadInstance = async (id: string) => {
    if (instances.has(id)) {
      return instances.get(id) ?? null;
    }
    const row = await instanceRepo.getById(id);
    instances.set(id, row);
    return row;
  };
  const loadProjectRpc = (instance: PrivateChannelInstanceRow) => {
    const key = `${instance.organization_id}:${instance.project_id}`;
    const cached = projectRpcs.get(key);
    if (cached) return cached;
    const loaded = loadProjectRpcClient({
      env,
      organizationId: instance.organization_id,
      projectId: instance.project_id,
    });
    projectRpcs.set(key, loaded);
    return loaded;
  };

  const now = Date.now();

  for (const deposit of pending) {
    try {
      if (deposit.status === "pending") {
        await failIfStale(env, repo, deposit, now, "Deposit was never broadcast.");
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
        await reconcileSubmitted(env, repo, deposit, await loadProjectRpc(instance), now);
      }
      // `confirmed` intentionally has no transition here — see module docstring.
    } catch (err) {
      logReconcileError(deposit.id, deposit.status, err);
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
  await failStale(env, repo, deposit, now, reason);
}

/** Signature-agnostic stale fail. */
async function failStale(
  env: Env,
  repo: PrivateChannelDepositRepository,
  deposit: PrivateChannelDepositRow,
  now: number,
  reason: string
): Promise<void> {
  if (now - Date.parse(deposit.updated_at) <= STUCK_AFTER_MS) {
    return;
  }
  const failed = await repo.updateDeposit({
    id: deposit.id,
    status: "failed",
    failureReason: reason,
    expectedStatus: deposit.status,
  });
  if (failed) {
    await emitDepositEvent(env, failed, "transfer.deposit.failed", "failed", {
      failureReason: reason,
    });
  }
}

/** submitted → confirmed/failed via on-chain signature status. */
async function reconcileSubmitted(
  env: Env,
  repo: PrivateChannelDepositRepository,
  deposit: PrivateChannelDepositRow,
  projectRpc: PrivateChannelProjectRpcClient,
  now: number
): Promise<void> {
  if (!deposit.signature) {
    await failIfStale(env, repo, deposit, now, "Deposit was submitted without a signature.");
    return;
  }

  const [status] = await solanaRpc.getSignatureStatuses(projectRpc.rpc, [
    deposit.signature as Signature,
  ]);

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
