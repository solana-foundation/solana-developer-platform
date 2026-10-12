import { getDb } from "@/db";
import {
  createPostgresIdempotencyKeyRepository,
  type IdempotencyKeyRepository,
} from "@/db/repositories/idempotency-keys.repository";
import { getLogger } from "@/runtime/logger";
import type { Env } from "@/types/env";

/** Rows deleted per statement, so one sweep never holds a long lock. */
export const IDEMPOTENCY_KEY_PRUNE_BATCH = 1000;
/** Batches per sweep; anything left over goes on the next tick. */
export const IDEMPOTENCY_KEY_PRUNE_MAX_BATCHES = 20;

export interface PruneIdempotencyKeysResult {
  deleted: number;
  /** Deleted rows that never recorded an outcome (still `in_progress`). */
  unfinished: number;
  /** True when the sweep stopped at its batch cap with expired rows left. */
  capped: boolean;
}

/**
 * Deletes Idempotency-Key records whose 24-hour retention has passed
 * (HOO-1918). Expired rows are already ignored by every claim, so a missed
 * sweep only costs disk, never correctness.
 *
 * A deleted row still `in_progress` is a request that never recorded an
 * outcome for a whole day: a crash the route's own row has to answer for. It is
 * logged as `sdp_idempotency_unfinished_pruned` at error level, for alerting.
 */
export async function pruneIdempotencyKeys(
  env: Env,
  repository: IdempotencyKeyRepository = createPostgresIdempotencyKeyRepository(getDb(env))
): Promise<PruneIdempotencyKeysResult> {
  let deleted = 0;
  let unfinished = 0;
  let capped = true;
  for (let batch = 0; batch < IDEMPOTENCY_KEY_PRUNE_MAX_BATCHES; batch += 1) {
    const pruned = await repository.pruneExpired(IDEMPOTENCY_KEY_PRUNE_BATCH);
    deleted += pruned.deleted;
    unfinished += pruned.unfinished;
    if (pruned.deleted < IDEMPOTENCY_KEY_PRUNE_BATCH) {
      capped = false;
      break;
    }
  }
  if (unfinished > 0) {
    getLogger().error(
      { event: "sdp_idempotency_unfinished_pruned", unfinished, deleted },
      "idempotency keys pruned that never recorded an outcome"
    );
  }
  if (deleted > 0) {
    getLogger().info(
      { deleted, capped },
      capped ? "idempotency keys pruned; more remain for the next run" : "idempotency keys pruned"
    );
  }
  return { deleted, unfinished, capped };
}
