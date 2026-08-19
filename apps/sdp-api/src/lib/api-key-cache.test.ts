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
    walletScope: "all",
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

/** A DB whose key-row reads return each row in sequence (last one repeats). */
function dbReturningSequence(rows: Array<Record<string, unknown> | null>): DatabaseClient {
  let call = 0;
  return {
    prepare: () => ({
      bind: () => ({
        first: async () => rows[Math.min(call++, rows.length - 1)] ?? null,
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

  it("never publishes a reader-trusted entry before verification", async () => {
    // A CAS win lands in the slot BEFORE the Postgres verify runs, and a
    // concurrent cache-hit reader would trust it during that gap — while
    // eviction may have erased a newer revocation's terminal entry. The
    // install must therefore carry the pendingVerification marker readers
    // treat as a miss; only the verified publish may be trusted.
    const installed: string[] = [];
    const kv = {
      ...contendedStore(null),
      get: async () => null,
      compareAndSet: async (_key: string, _expected: string | null, value: string) => {
        installed.push(value);
        return true;
      },
      put: async () => {},
    } as KVStore;
    const activeRow = { ...revokedRow(), status: "active" };

    await fillApiKeyCache(dbReturning(activeRow), kv, KEY_HASH, entryWithStatus("active"));

    const first = JSON.parse(installed[0] ?? "{}") as { pendingVerification?: boolean };
    expect(first.pendingVerification).toBe(true);
    // The verified publish replaces the marker with the trusted entry.
    const last = JSON.parse(installed[installed.length - 1] ?? "{}") as {
      pendingVerification?: boolean;
      status?: string;
    };
    expect(last.pendingVerification).toBeUndefined();
    expect(last.status).toBe("active");
  });

  it("adopts the revocation that replaced its pending marker before the publish", async () => {
    // Clean verify, but the publish CAS loses: a revocation's terminal
    // write replaced the pending marker between the verify read and the
    // publish. The lost CAS is a signal, not noise — the fill must fence
    // the slot and authenticate against the terminal state instead of its
    // earlier active snapshot.
    const revoked = entryWithStatus("revoked");
    let casCalls = 0;
    const kv = {
      ...contendedStore(null),
      get: async () => JSON.stringify(revoked),
      compareAndSet: async () => {
        casCalls += 1;
        return casCalls === 1; // install wins, publish loses
      },
      put: async () => {},
    } as KVStore;
    const activeRow = { ...revokedRow(), status: "active" };

    const adopted = await fillApiKeyCache(
      dbReturning(activeRow),
      kv,
      KEY_HASH,
      entryWithStatus("active")
    );

    expect(adopted.status).toBe("revoked");
  });

  it("honors a stickier terminal entry when repairing a drifted install", async () => {
    // Drifted verify (fresh differs from the installed snapshot) while the
    // slot already holds a revocation's terminal entry: the terminal-sticky
    // overwrite keeps that entry, and the fill must return it rather than
    // the fresh active state it read moments before the revocation.
    const revoked = entryWithStatus("revoked");
    const kv = {
      ...contendedStore(null),
      get: async () => JSON.stringify(revoked),
      compareAndSet: async (_key: string, expected: string | null) => expected === null,
      put: async () => {},
    } as KVStore;
    const activeRow = { ...revokedRow(), status: "active" };

    const adopted = await fillApiKeyCache(dbReturning(activeRow), kv, KEY_HASH, {
      ...entryWithStatus("active"),
      // Distinct from what the DB returns so the verify takes the drift path.
      permissions: [],
    });

    expect(adopted.status).toBe("revoked");
  });

  it("re-reads Postgres when the publish loses and the terminal entry was evicted", async () => {
    // The publish CAS loses to a revocation's terminal write — and Redis
    // evicts that entry before the slot can be fenced. The cache holds no
    // evidence, but the lost CAS proves the competing write postdates the
    // install, so Postgres (which cannot be evicted) must be re-read: that
    // read provably postdates the revocation commit that caused the loss.
    let casCalls = 0;
    const kv = {
      ...contendedStore(null),
      get: async () => null, // evicted: the slot never shows the terminal entry
      compareAndSet: async () => {
        casCalls += 1;
        return casCalls === 1; // install wins, publish loses
      },
      put: async () => {},
    } as KVStore;
    const activeRow = { ...revokedRow(), status: "active" };

    const adopted = await fillApiKeyCache(
      dbReturningSequence([activeRow, revokedRow()]),
      kv,
      KEY_HASH,
      entryWithStatus("active")
    );

    expect(adopted.status).toBe("revoked");
  });

  it("keeps the terminal entry it observed when a drift repair defers to it", async () => {
    // Drifted verify: the terminal-sticky overwrite sees a revocation's
    // entry and keeps it — then Redis evicts it before any later fence
    // read. The value observed at overwrite time must be what the fill
    // authenticates against, not a lucky second look at the slot.
    const revoked = entryWithStatus("revoked");
    let reads = 0;
    const kv = {
      ...contendedStore(null),
      get: async () => {
        reads += 1;
        return reads === 1 ? JSON.stringify(revoked) : null; // observed once, then evicted
      },
      compareAndSet: async (_key: string, expected: string | null) => expected === null,
      put: async () => {},
    } as KVStore;
    const activeRow = { ...revokedRow(), status: "active" };

    const adopted = await fillApiKeyCache(dbReturning(activeRow), kv, KEY_HASH, {
      ...entryWithStatus("active"),
      // Distinct from what the DB returns so the verify takes the drift path.
      permissions: [],
    });

    expect(adopted.status).toBe("revoked");
  });

  it("fences the fallback re-read against a revocation landing during it", async () => {
    // Exhaustion path: every loop read sees an empty slot (reads 1-4), the
    // Postgres re-read returns an active snapshot — and in the gap before
    // the fallback returns, a concurrent revocation commits and lands its
    // terminal entry in the slot. The fence read must observe it and let
    // the terminal state win instead of authorizing the active snapshot.
    const revoked = entryWithStatus("revoked");
    let reads = 0;
    const kv = {
      ...contendedStore(null),
      get: async () => {
        reads += 1;
        return reads <= 4 ? null : JSON.stringify(revoked);
      },
    } as KVStore;
    const activeRow = { ...revokedRow(), status: "active" };

    const adopted = await fillApiKeyCache(dbReturning(activeRow), kv, KEY_HASH, {
      ...entryWithStatus("active"),
      // Distinct from what the DB returns, so the CAS loop keeps losing
      // rather than short-circuiting on an authoritative match.
      permissions: [],
    });

    expect(adopted.status).toBe("revoked");
  });

  it("verifies a WON install against Postgres and repairs an evicted revocation", async () => {
    // The slot is empty because eviction removed the revocation's terminal
    // entry, so the write-if-absent CAS succeeds — but the win proves
    // nothing, and Postgres says revoked.
    const writes: string[] = [];
    const kv = {
      ...contendedStore(null),
      get: async () => null,
      compareAndSet: async () => true,
      put: async (_key: string, value: string) => {
        writes.push(value);
      },
    } as KVStore;

    const adopted = await fillApiKeyCache(
      dbReturning(revokedRow()),
      kv,
      KEY_HASH,
      entryWithStatus("active")
    );

    expect(adopted.status).toBe("revoked");
  });

  it("trusts a WON install without extra cache writes while Postgres still matches", async () => {
    const writes: string[] = [];
    const kv = {
      ...contendedStore(null),
      get: async () => null,
      compareAndSet: async () => true,
      put: async (_key: string, value: string) => {
        writes.push(value);
      },
    } as KVStore;
    const entry = entryWithStatus("active");
    const activeRow = { ...revokedRow(), status: "active" };

    const adopted = await fillApiKeyCache(dbReturning(activeRow), kv, KEY_HASH, entry);

    expect(adopted).toBe(entry);
    expect(writes).toHaveLength(0);
  });
});
