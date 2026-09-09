import { getDb } from "@/db";
import { createPostgresEarnMovementsRepository } from "@/db/repositories/earn-movements.repository";
import { logEvent } from "@/runtime/money-path-events";
import { reconcileEarnVaultMovementBatch } from "@/services/earn/vault-movement-reconciliation.service";
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
 * Every tick emits `sdp_api_earn_vault_reconciliation_tick` (PRO-1863, the
 * `sdp_api_sponsorship_reconciliation_tick` precedent): claimed/settled/failed
 * counts plus the post-tick backlog and age-of-oldest-unsettled, which is what
 * the Grafana backlog and movement-age alerts key on. A chain read failure
 * still emits the tick (at error level, with the failure counts) and then
 * THROWS, so the cron run reads failed instead of ok while nothing settles
 * (EARN-006: an RPC outage used to be swallowed into an ok tick).
 */
export async function reconcileEarnVaultMovements(env: Env): Promise<void> {
  const ledger = createPostgresEarnMovementsRepository(getDb(env));
  const movements = await ledger.claimUnsettledVaultMovements(OUTBOX_BATCH_SIZE);
  const stats = await reconcileEarnVaultMovementBatch(env, movements);
  const { backlog, oldestUnsettledCreatedAt } = await ledger.getUnsettledVaultMovementStats();

  const readFailures = stats.statusReadFailures + stats.blockHeightReadFailures;
  logEvent(readFailures > 0 ? "error" : "info", {
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
    backlog,
    oldest_unsettled_age_seconds: ageInSeconds(oldestUnsettledCreatedAt),
    batch_saturated: movements.length === OUTBOX_BATCH_SIZE,
  });

  if (readFailures > 0) {
    throw new Error(
      `Earn vault reconciliation could not read chain state ` +
        `(${stats.statusReadFailures} status, ${stats.blockHeightReadFailures} block-height failures); ` +
        `${stats.unchanged} of ${stats.claimed} claimed movements went unjudged`
    );
  }
}

function ageInSeconds(createdAt: string | null): number | null {
  if (createdAt === null) return null;
  const created = new Date(createdAt).getTime();
  if (Number.isNaN(created)) return null;
  return Math.max(0, Math.round((Date.now() - created) / 1000));
}
