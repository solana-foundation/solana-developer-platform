/**
 * Regression tests for the CAS-exhaustion fallback in fillApiKeyCache: when
 * every write attempt loses (each slot read saw nothing, but a competing
 * write landed before our CAS), the losing fill must authenticate against
 * authoritative state — the winning cache entry if one is observable, and a
 * fresh Postgres read when the slot is empty or legacy even after losing
 * (TTL expiry or cache eviction removed the winner). Falling back to the
 * fill's own pre-race snapshot would let a revocation that landed during
 * those windows be ignored by the very request that raced it.
 */

import type { CachedApiKey } from "@sdp/types";
import { describe, expect, it } from "vitest";
import type { KVStore } from "@/runtime/kv";
import { fillApiKeyCache } from "./api-key-cache";

const KEY_HASH = "hash_fill_race_exhaustion";

function entryWithStatus(status: CachedApiKey["status"]): CachedApiKey {
  return {
    id: "key_fill_race",
    organizationId: "org_fill_race",
    projectId: "prj_fill_race",
    role: "api_admin",
    permissions: ["*"],
    environment: "sandbox",
    rateLimitTier: "standard",
    allowedIps: null,
    signingWalletId: null,
    signingWalletIds: [],
    walletBindings: [],
    status,
    expiresAt: null,
    rotationDeadline: null,
    organizationStatus: "active",
  };
}

/**
 * Models the worst-case interleaving: every read during the fill loop sees
 * an empty slot, every CAS loses to a competing writer, and by the time the
 * loop has exhausted its attempts a revocation tombstone occupies the slot.
 */
function contendedStore(finalValue: string | null): KVStore {
  let reads = 0;
  return {
    get: async () => {
      reads += 1;
      return reads <= 3 ? null : finalValue;
    },
    put: async () => {},
    delete: async () => {},
    compareAndSet: async () => false,
    compareAndDelete: async () => false,
    list: async () => ({ keys: [] }),
    admitSlidingWindow: async () => ({ admitted: true, current: 0, previous: 0 }),
  } as KVStore;
}

/** A DB whose key-row read returns `row` and whose bindings read is empty. */
function dbReturning(row: Record<string, unknown> | null): DatabaseClient {
  return {
    prepare: () => ({
      bind: () => ({
        first: async () => row,
        all: async () => ({ results: [] }),
      }),
    }),
  } as unknown as DatabaseClient;
}

function dbThatMustNotBeRead(): DatabaseClient {
  return {
    prepare: () => {
      throw new Error("authoritative cache state must be adopted without a DB read");
    },
  } as unknown as DatabaseClient;
}

function revokedRow(): Record<string, unknown> {
  return {
    id: "key_fill_race",
    organization_id: "org_fill_race",
    project_id: "prj_fill_race",
    role: "api_admin",
    permissions: JSON.stringify(["*"]),
    environment: "sandbox",
    rate_limit_tier: "standard",
    allowed_ips: null,
    signing_wallet_id: null,
    status: "revoked",
    expires_at: null,
    rotation_deadline: null,
    organization_status: "active",
  };
}

describe("fillApiKeyCache under CAS exhaustion", () => {
  it("adopts the revoked state that won the slot instead of its own stale snapshot", async () => {
    const revoked = entryWithStatus("revoked");
    const kv = contendedStore(JSON.stringify(revoked));

    const adopted = await fillApiKeyCache(
      dbThatMustNotBeRead(),
      kv,
      KEY_HASH,
      entryWithStatus("active")
    );

    expect(adopted.status).toBe("revoked");
  });

  it("re-reads Postgres when the slot is empty even after losing every attempt", async () => {
    // The winning write was evicted (or TTL-expired) between our CAS loss
    // and the final read: the slot proves nothing, and the fill's own
    // snapshot predates whatever won. Authoritative state lives in Postgres.
    const kv = contendedStore(null);

    const adopted = await fillApiKeyCache(
      dbReturning(revokedRow()),
      kv,
      KEY_HASH,
      entryWithStatus("active")
    );

    expect(adopted.status).toBe("revoked");
  });

  it("rejects as terminal when the row is gone by the time the fallback re-reads", async () => {
    const kv = contendedStore(null);

    const adopted = await fillApiKeyCache(
      dbReturning(null),
      kv,
      KEY_HASH,
      entryWithStatus("active")
    );

    expect(adopted.status).toBe("revoked");
    expect(adopted.organizationStatus).toBe("deleted");
  });
});
