import { getDb } from "@/db";
import { createPostgresEarnMovementsRepository } from "@/db/repositories/earn-movements.repository";
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
 */
export async function reconcileEarnVaultMovements(env: Env): Promise<void> {
  const ledger = createPostgresEarnMovementsRepository(getDb(env));
  const movements = await ledger.claimUnsettledVaultMovements(OUTBOX_BATCH_SIZE);
  await reconcileEarnVaultMovementBatch(env, movements);
}
