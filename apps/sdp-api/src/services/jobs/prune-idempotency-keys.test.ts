import { describe, expect, it, vi } from "vitest";
import type { IdempotencyKeyRepository } from "@/db/repositories/idempotency-keys.repository";
import { getLogger } from "@/runtime/logger";
import { env } from "@/test/helpers/env";
import {
  IDEMPOTENCY_KEY_PRUNE_BATCH,
  IDEMPOTENCY_KEY_PRUNE_MAX_BATCHES,
  pruneIdempotencyKeys,
} from "./prune-idempotency-keys";

function repositoryDeleting(counts: number[], unfinished: number[] = []): IdempotencyKeyRepository {
  const unused = () => Promise.reject(new Error("not used by the prune"));
  return {
    claim: unused,
    renew: unused,
    complete: unused,
    discard: unused,
    unlock: unused,
    pruneExpired: vi.fn(async () => ({
      deleted: counts.shift() ?? 0,
      unfinished: unfinished.shift() ?? 0,
    })),
  };
}

describe("pruneIdempotencyKeys", () => {
  it("deletes in batches until a batch comes back short", async () => {
    const repository = repositoryDeleting([IDEMPOTENCY_KEY_PRUNE_BATCH, 7]);
    expect(await pruneIdempotencyKeys(env, repository)).toEqual({
      deleted: IDEMPOTENCY_KEY_PRUNE_BATCH + 7,
      unfinished: 0,
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
      unfinished: 0,
      capped: true,
    });
  });

  it("alerts when it deletes a request that never recorded an outcome", async () => {
    const error = vi.spyOn(getLogger(), "error");
    const repository = repositoryDeleting([3], [2]);
    expect(await pruneIdempotencyKeys(env, repository)).toEqual({
      deleted: 3,
      unfinished: 2,
      capped: false,
    });
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ event: "sdp_idempotency_unfinished_pruned", unfinished: 2 }),
      expect.any(String)
    );
  });
});
