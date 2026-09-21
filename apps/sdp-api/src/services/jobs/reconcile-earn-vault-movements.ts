import { getDb } from "@/db";
import { createPostgresEarnMovementsRepository } from "@/db/repositories/earn-movements.repository";
import { logEvent } from "@/runtime/money-path-events";
import {
  reconcileEarnVaultMovementBatch,
  repairUnvaluedWithdrawalPayouts,
} from "@/services/earn/vault-movement-reconciliation.service";
import { reconcileEarnVaultQueuedWithdrawals } from "@/services/earn/vault-queued-withdrawal-reconciliation.service";
import type { Env } from "@/types/env";

const OUTBOX_BATCH_SIZE = 256;

/**
 * Reconcile every recorded signed vault transaction to an IRREVERSIBLE outcome.
 *
 * "Terminal" moved (PRO-1716). Optimistic commitment is not settlement — a
 * confirmed transaction can still be dropped in a fork rollback — so the queue
 * now includes `confirmed` rows and the sweep keeps polling them until the chain
 * says `finalized`. One meaning of settled across SDP, matching what payments
 * does for transfers.
 *
 * Every transition goes through the one ledger writer, and every legal source
 * state comes from the shared transition matrix — so a status this sweep cannot
 * legitimately reach is unrepresentable rather than merely unlikely.
 *
 * A completed tick emits `sdp_api_earn_vault_reconciliation_tick` (PRO-1863,
 * the `sdp_api_sponsorship_reconciliation_tick` precedent): claimed/settled/
 * failed counts plus the post-tick backlog and ages. The backlog, movement-age
 * and health rules that key on them live as code in the sdp-infra repo
 * (`kora/alert-rules/sdp-earn-*.json`, PRO-1903). A chain read failure or a
 * per-movement failure still emits the tick (at error level, with the failure
 * counts) and then THROWS, so the cron run reads failed instead of ok while
 * nothing settles (EARN-006: an RPC outage used to be swallowed into an ok
 * tick).
 *
 * "Completed" is the honest qualifier: a rejection from the claim or backlog
 * QUERY itself skips the event, exactly as the sponsorship reconciler skips
 * its tick when its own candidate read fails. That is deliberate, not a gap.
 * The run is still loud (`sdp_cron_run` records `status: "error"` and the job
 * exits non-zero), and a synthesized fallback tick could only carry a null
 * backlog (invisible to a threshold rule, i.e. identical to no tick) or a zero
 * (actively harmful: it reads as a drained queue and would CLEAR a firing
 * backlog alert mid-incident). Alert on the absence of the tick, never on a
 * fabricated one.
 */
export async function reconcileEarnVaultMovements(env: Env): Promise<void> {
  // Start the independent queue/PDA projection before touching the instant
  // movement ledger. Even a persistent claim/payout/backlog query failure must
  // not strand escrowed shares by preventing this sibling from running.
  const queuedRun = reconcileEarnVaultQueuedWithdrawals(env).then(
    () => null,
    (error: unknown) => error
  );
  let ledger: ReturnType<typeof createPostgresEarnMovementsRepository>;
  let movements: Awaited<ReturnType<typeof ledger.claimUnsettledVaultMovements>>;
  let stats: Awaited<ReturnType<typeof reconcileEarnVaultMovementBatch>>;
  let payoutRepair: Awaited<ReturnType<typeof repairUnvaluedWithdrawalPayouts>>;
  let backlogStats: Awaited<ReturnType<typeof ledger.getUnsettledVaultMovementStats>>;
  try {
    ledger = createPostgresEarnMovementsRepository(getDb(env));
    movements = await ledger.claimUnsettledVaultMovements(OUTBOX_BATCH_SIZE);
    stats = await reconcileEarnVaultMovementBatch(env, movements);
    // Second chance for withdrawal payouts the settlement could not observe;
    // a failed history read must not understate `totalWithdrawn` forever.
    payoutRepair = await repairUnvaluedWithdrawalPayouts(env);
    backlogStats = await ledger.getUnsettledVaultMovementStats();
  } catch (movementPipelineFailure) {
    const queuedWithdrawalFailure = await queuedRun;
    if (queuedWithdrawalFailure !== null) {
      throw new AggregateError(
        [movementPipelineFailure, queuedWithdrawalFailure],
        "Earn vault movement and queued-withdrawal reconciliation both failed"
      );
    }
    throw movementPipelineFailure;
  }
  const queuedWithdrawalFailure = await queuedRun;

  // Per-movement failures count toward the verdict too, not just chain reads:
  // a Postgres pool exhaustion or a send-side RPC outage makes every
  // `advanceVaultMovement`/broadcast throw while both reads answer fine, and
  // reporting that batch as an ok tick is the same EARN-006 silence this job
  // exists to close. Same posture as the sponsorship reconciler, which emits
  // its tick and then throws an AggregateError when any item failed.
  const failures =
    stats.statusReadFailures +
    stats.blockHeightReadFailures +
    stats.movementErrors +
    payoutRepair.errors;
  logEvent(failures > 0 ? "error" : "info", {
    event: "sdp_api_earn_vault_reconciliation_tick",
    claimed: stats.claimed,
    settled: stats.settled,
    failed: stats.failed,
    confirmed: stats.confirmed,
    resubmitted: stats.resubmitted,
    unchanged: stats.unchanged,
    movement_errors: stats.movementErrors,
    status_read_failures: stats.statusReadFailures,
    block_height_read_failures: stats.blockHeightReadFailures,
    backlog: backlogStats.backlog,
    // The actionable subset: a `confirmed` row whose signature aged out never
    // leaves the backlog, so a total-only age would latch and page forever.
    backlog_blockhash_bound: backlogStats.backlogBlockhashBound,
    backlog_confirmed: backlogStats.backlogConfirmed,
    backlog_withdrawals: backlogStats.backlogWithdrawals,
    oldest_unsettled_age_seconds: ageInSeconds(backlogStats.oldestUnsettledCreatedAt),
    oldest_blockhash_bound_age_seconds: ageInSeconds(backlogStats.oldestBlockhashBoundCreatedAt),
    // ADR 0002: the exit path gets its own number rather than hiding inside the
    // total, so a stuck withdrawal is visible without disaggregating.
    oldest_withdrawal_age_seconds: ageInSeconds(backlogStats.oldestWithdrawalCreatedAt),
    batch_saturated: movements.length === OUTBOX_BATCH_SIZE,
    payout_repair_claimed: payoutRepair.claimed,
    payout_repair_repaired: payoutRepair.repaired,
    payout_repair_unobserved: payoutRepair.unobserved,
    payout_repair_errors: payoutRepair.errors,
  });

  if (failures > 0) {
    const movementFailure = new Error(
      `Earn vault reconciliation failed ` +
        `(${stats.statusReadFailures} status-read, ${stats.blockHeightReadFailures} block-height, ` +
        `${stats.movementErrors} per-movement failures, ${payoutRepair.errors} payout-repair failures) ` +
        `over ${stats.claimed} claimed movements`
    );
    if (queuedWithdrawalFailure !== null) {
      throw new AggregateError(
        [movementFailure, queuedWithdrawalFailure],
        "Earn vault movement and queued-withdrawal reconciliation both failed"
      );
    }
    throw movementFailure;
  }
  if (queuedWithdrawalFailure !== null) {
    throw queuedWithdrawalFailure;
  }
}

function ageInSeconds(createdAt: string | null): number | null {
  if (createdAt === null) return null;
  const created = new Date(createdAt).getTime();
  if (Number.isNaN(created)) return null;
  return Math.max(0, Math.round((Date.now() - created) / 1000));
}
