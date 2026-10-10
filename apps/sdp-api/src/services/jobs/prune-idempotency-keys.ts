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
  /** True when the sweep stopped at its batch cap with expired rows left. */
  capped: boolean;
}

/**
 * Deletes Idempotency-Key records whose 24-hour retention has passed
 * (HOO-1918). Expired rows are already ignored by every claim, so a missed
 * sweep only costs disk, never correctness.
 */
export async function pruneIdempotencyKeys(
  env: Env,
  repository: IdempotencyKeyRepository = createPostgresIdempotencyKeyRepository(getDb(env))
): Promise<PruneIdempotencyKeysResult> {
  let deleted = 0;
  for (let batch = 0; batch < IDEMPOTENCY_KEY_PRUNE_MAX_BATCHES; batch += 1) {
    const count = await repository.pruneExpired(IDEMPOTENCY_KEY_PRUNE_BATCH);
    deleted += count;
    if (count < IDEMPOTENCY_KEY_PRUNE_BATCH) {
      if (deleted > 0) getLogger().info({ deleted }, "idempotency keys pruned");
      return { deleted, capped: false };
    }
  }
  getLogger().info({ deleted }, "idempotency keys pruned; more remain for the next run");
  return { deleted, capped: true };
}
