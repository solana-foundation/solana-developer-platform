import { describe, expect, it, vi } from "vitest";
import type { IdempotencyKeyRepository } from "@/db/repositories/idempotency-keys.repository";
import { env } from "@/test/helpers/env";
import {
  IDEMPOTENCY_KEY_PRUNE_BATCH,
  IDEMPOTENCY_KEY_PRUNE_MAX_BATCHES,
  pruneIdempotencyKeys,
} from "./prune-idempotency-keys";

function repositoryDeleting(counts: number[]): IdempotencyKeyRepository {
  const unused = () => Promise.reject(new Error("not used by the prune"));
  return {
    claim: unused,
    renew: unused,
    complete: unused,
    discard: unused,
    unlock: unused,
    pruneExpired: vi.fn(async () => counts.shift() ?? 0),
  };
}

describe("pruneIdempotencyKeys", () => {
  it("deletes in batches until a batch comes back short", async () => {
    const repository = repositoryDeleting([IDEMPOTENCY_KEY_PRUNE_BATCH, 7]);
    expect(await pruneIdempotencyKeys(env, repository)).toEqual({
      deleted: IDEMPOTENCY_KEY_PRUNE_BATCH + 7,
      capped: false,
    });
    expect(repository.pruneExpired).toHaveBeenCalledTimes(2);
  });

  it("stops at its batch cap and leaves the rest for the next run", async () => {
    const repository = repositoryDeleting(
      Array.from(
        { length: IDEMPOTENCY_KEY_PRUNE_MAX_BATCHES + 5 },
        () => IDEMPOTENCY_KEY_PRUNE_BATCH
      )
    );
    expect(await pruneIdempotencyKeys(env, repository)).toEqual({
      deleted: IDEMPOTENCY_KEY_PRUNE_BATCH * IDEMPOTENCY_KEY_PRUNE_MAX_BATCHES,
      capped: true,
    });
  });
});
