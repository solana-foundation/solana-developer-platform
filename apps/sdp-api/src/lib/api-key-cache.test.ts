/**
 * Regression tests for the CAS-exhaustion fallback in fillApiKeyCache: when
 * every write attempt loses (each slot read saw nothing, but a competing
 * write landed before our CAS), the losing fill must authenticate against
 * authoritative state — the winning cache entry if one is observable, and a
 * fresh Postgres read when the slot is empty or legacy even after losing
 * (TTL expiry or cache eviction removed the winner). Falling back to the
 * fill's own pre-race snapshot would let a revocation that landed during
 * those windows be ignored by the very request that raced it.
 *
 * The deploy-compat class (selected scope, no bindings) is the same problem
 * without a CAS to lose: it caches nothing, so an empty slot could equally
 * be a never-written one or a revocation's terminal entry that Redis
 * evicted, and only Postgres can tell those apart.
 *
 * Also covers refreshApiKeyCache's convergence contract: an empty slot is
 * never claimed with unverified non-terminal state, and CAS exhaustion that
 * leaves a possibly-stale entry cached is reported to the caller instead of
 * passing as success.
 */

import type { CachedApiKey } from "@sdp/types";
import { describe, expect, it } from "vitest";
import type { KVStore } from "@/runtime/kv";
import { apiKeyCacheKey, fillApiKeyCache, refreshApiKeyCache } from "./api-key-cache";

const KEY_HASH = "hash_fill_race_exhaustion";
const TOKEN_KEY_HASH = "hash_install_token_fence";

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

/**
 * A store for the deploy-compat class: the slot reads back as `slotValue`,
 * and any write fails the test — this key class must never be cached.
 */
function uncacheableStore(slotValue: string | null): KVStore {
  return {
    ...contendedStore(null),
    get: async () => slotValue,
    compareAndSet: async () => {
      throw new Error("this key class must never be cached");
    },
    put: async () => {
      throw new Error("this key class must never be cached");
    },
  } as KVStore;
}

/**
 * A key row that hydrates into the deploy-compat class: its signing wallet
 * no longer resolves to an active custody wallet, so the binding is dropped
 * and the key reads back as selected-scope with no bindings.
 */
function unresolvedBindingRow(status: string): Record<string, unknown> {
  return { ...revokedRow(), status, signing_wallet_id: "wal_unresolved" };
}

describe("fillApiKeyCache deploy-compat class (selected scope, no bindings)", () => {
  it("fences the uncacheable class against a revocation that raced the DB read", async () => {
    // This class never installs, so no lost CAS can ever signal a raced
    // revocation. The slot it deliberately leaves empty can only hold a
    // revocation's terminal write (or tombstone) — landing there strictly
    // after this fill's DB read. Skipping the fence would authorize the
    // pre-revocation snapshot.
    const revoked = entryWithStatus("revoked");
    const kv = uncacheableStore(JSON.stringify(revoked));

    const adopted = await fillApiKeyCache(dbThatMustNotBeRead(), kv, KEY_HASH, {
      ...entryWithStatus("active"),
      walletScope: "selected",
      walletBindings: [],
    });

    expect(adopted.status).toBe("revoked");
  });

  it("re-reads Postgres when the fence finds the slot empty, so an evicted revocation is not missed", async () => {
    // The revocation committed and wrote its terminal entry before this
    // fence ran; Redis then evicted it, leaving the slot indistinguishable
    // from one that was never written. This class installs nothing, so
    // there is no CAS result to read the race from either. Adopting the
    // fill's own pre-revocation snapshot here would authorize a key whose
    // revocation had already reported success.
    const kv = uncacheableStore(null);

    const adopted = await fillApiKeyCache(
      dbReturning(unresolvedBindingRow("revoked")),
      kv,
      KEY_HASH,
      {
        ...entryWithStatus("active"),
        walletScope: "selected",
        walletBindings: [],
      }
    );

    expect(adopted.status).toBe("revoked");
  });

  it("still caches nothing for this class when Postgres confirms the key is live", async () => {
    const kv = uncacheableStore(null);

    const adopted = await fillApiKeyCache(
      dbReturning(unresolvedBindingRow("active")),
      kv,
      KEY_HASH,
      {
        ...entryWithStatus("active"),
        walletScope: "selected",
        walletBindings: [],
      }
    );

    expect(adopted.status).toBe("active");
    expect(adopted.walletScope).toBe("selected");
    expect(adopted.walletBindings).toEqual([]);
  });
});

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

  it("re-reads Postgres when a drift repair finds the slot emptied", async () => {
    // Drifted verify, and by the time the repair looks at the slot our own
    // pending marker is gone — exactly what an evicted revocation entry
    // looks like. Winning a CAS(null → fresh) there would republish a
    // possibly-revoked key as trusted active state for a full TTL, so the
    // repair must write nothing and resolve from Postgres instead.
    const casValues: string[] = [];
    const kv = {
      ...contendedStore(null),
      get: async () => null,
      compareAndSet: async (_key: string, _expected: string | null, value: string) => {
        casValues.push(value);
        return true;
      },
      put: async () => {},
    } as KVStore;
    const activeRow = { ...revokedRow(), status: "active" };

    const adopted = await fillApiKeyCache(
      dbReturningSequence([activeRow, revokedRow()]),
      kv,
      KEY_HASH,
      {
        ...entryWithStatus("active"),
        // Distinct from what the DB returns so the verify takes the drift path.
        permissions: [],
      }
    );

    expect(adopted.status).toBe("revoked");
    // Only the pending install may ever land in the observed-empty slot.
    const trustedInstalls = casValues
      .map((value) => JSON.parse(value) as CachedApiKey)
      .filter((parsed) => !parsed.pendingVerification);
    expect(trustedInstalls).toHaveLength(0);
  });

  it("resolves a drift repair from Postgres when churn wins every round", async () => {
    // The repair's overwrite loses all three CAS rounds to concurrent
    // non-terminal writes. Those wins postdate the verify read, so the
    // fresh active snapshot proves nothing — only Postgres can say whether
    // one of them was racing a revocation.
    const churnValue = JSON.stringify({
      ...entryWithStatus("active"),
      rateLimitTier: "elevated" as const,
    });
    let casCalls = 0;
    const kv = {
      ...contendedStore(null),
      get: async () => churnValue,
      compareAndSet: async () => {
        casCalls += 1;
        return casCalls === 1; // install wins, every repair round loses
      },
      put: async () => {},
    } as KVStore;
    const activeRow = { ...revokedRow(), status: "active" };

    const adopted = await fillApiKeyCache(
      dbReturningSequence([activeRow, revokedRow()]),
      kv,
      KEY_HASH,
      {
        ...entryWithStatus("active"),
        // Distinct from what the DB returns so the verify takes the drift path.
        permissions: [],
      }
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

describe("refreshApiKeyCache convergence contract", () => {
  it("leaves an empty slot empty rather than installing unverified state", async () => {
    // Emptiness is indistinguishable from eviction of a newer terminal
    // entry. A refresh must not claim the slot with trusted non-terminal
    // state — an empty slot is already convergent, because the next request
    // misses and re-fills through the verified two-phase path.
    const writes: string[] = [];
    const kv = {
      ...contendedStore(null),
      get: async () => null,
      compareAndSet: async (_key: string, _expected: string | null, value: string) => {
        writes.push(value);
        return true;
      },
      put: async (_key: string, value: string) => {
        writes.push(value);
      },
    } as KVStore;
    const activeRow = { ...revokedRow(), status: "active" };

    const converged = await refreshApiKeyCache(dbReturning(activeRow), kv, KEY_HASH);

    expect(converged).toBe(true);
    expect(writes).toHaveLength(0);
  });

  it("reports contention that leaves a possibly-stale entry cached", async () => {
    // A permission reduction races sustained slot churn: every CAS round
    // loses and the broader pre-mutation entry is still what readers see.
    // The refresh must say so instead of letting the mutation report
    // success over it.
    const staleBroadValue = JSON.stringify(entryWithStatus("active"));
    const kv = {
      ...contendedStore(null),
      get: async () => staleBroadValue,
      compareAndSet: async () => false,
      put: async () => {
        throw new Error("a non-terminal refresh must never write unconditionally");
      },
    } as KVStore;
    const reducedRow = {
      ...revokedRow(),
      status: "active",
      permissions: JSON.stringify(["projects:read"]),
    };

    const converged = await refreshApiKeyCache(dbReturning(reducedRow), kv, KEY_HASH);

    expect(converged).toBe(false);
  });

  it("lands a terminal state unconditionally after exhaustion", async () => {
    const staleBroadValue = JSON.stringify(entryWithStatus("active"));
    const puts: string[] = [];
    const kv = {
      ...contendedStore(null),
      get: async () => staleBroadValue,
      compareAndSet: async () => false,
      put: async (_key: string, value: string) => {
        puts.push(value);
      },
    } as KVStore;

    const converged = await refreshApiKeyCache(dbReturning(revokedRow()), kv, KEY_HASH);

    expect(converged).toBe(true);
    expect(puts).toHaveLength(1);
    expect((JSON.parse(puts[0] ?? "{}") as CachedApiKey).status).toBe("revoked");
  });
});

/**
 * Deterministic reproduction of the SOLA9-624 interleaving: two fills whose
 * DB reads return the same pre-revocation snapshot install byte-identical
 * pendingVerification markers, so a fill's publish CAS cannot tell its own
 * marker from another fill's. After the revocation's terminal entry is
 * written and then evicted, the older fill — whose verify read predates the
 * revocation — can publish trusted active state over the newer fill's
 * marker, re-authorizing a revoked key from cache until the newer fill's
 * repair lands.
 *
 * The gates below pin the interleaving the same way the event loop would:
 * `armReadGate` suspends a fill at its Postgres verify read, and
 * `armCasGate` suspends the newer fill's repair mid-CAS — leaving the
 * newer fill's pending marker in the slot when the older fill resumes.
 */
describe("fillApiKeyCache install fencing (SOLA9-624)", () => {
  interface Deferred<T> {
    promise: Promise<T>;
    resolve: (value: T) => void;
  }

  function createDeferred<T>(): Deferred<T> {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((given) => {
      resolve = given;
    });
    return { promise, resolve };
  }

  /** Yield until every runnable microtask has blocked on a gate. */
  const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

  type Row = Record<string, unknown>;

  /**
   * In-memory slot store. `armCasGate` suspends the next compareAndSet
   * before it applies, modeling repair contention, and returns that CAS's
   * release handle. The expected-state check runs only after the gate
   * opens, so a write landing while the gate is closed makes the suspended
   * CAS lose, like the real Redis CAS would. Only applied writes are
   * recorded in `writes` — a losing CAS must not read as a cache write.
   */
  function gatedKV() {
    const slot = new Map<string, string>();
    const writes: Array<{ expected: string | null; value: string }> = [];
    const casGates: Array<Deferred<void>> = [];
    const kv = {
      get: async (key: string) => slot.get(key) ?? null,
      put: async (key: string, value: string) => {
        slot.set(key, value);
        writes.push({ expected: null, value });
      },
      delete: async (key: string) => {
        slot.delete(key);
      },
      compareAndSet: async (key: string, expected: string | null, value: string) => {
        const gate = casGates.shift();
        if (gate) {
          await gate.promise;
        }
        if ((slot.get(key) ?? null) !== expected) {
          return false;
        }
        slot.set(key, value);
        writes.push({ expected, value });
        return true;
      },
      compareAndDelete: async () => false,
      list: async () => ({ keys: [] }),
      admitSlidingWindow: async () => ({ admitted: true, current: 0, previous: 0 }),
    } as KVStore;
    return {
      kv,
      slot,
      writes,
      armCasGate(): () => void {
        const gate = createDeferred<void>();
        casGates.push(gate);
        return () => gate.resolve();
      },
    };
  }

  /**
   * Key-row source: ungated reads serve the pre- or post-revocation row per
   * the revocation flag; `armReadGate` suspends the next row read in arming
   * order until its release handle hands it an explicit row (a verify read
   * whose result was fixed before the revocation committed).
   */
  function gatedDb(activeRow: Row, revokedRowValue: Row) {
    let revoked = false;
    const gateQueue: Array<Deferred<Row>> = [];
    const db = {
      prepare: () => ({
        bind: () => ({
          first: async () => {
            const gate = gateQueue.shift();
            if (gate) {
              return await gate.promise;
            }
            return revoked ? revokedRowValue : activeRow;
          },
          all: async () => ({ results: [] }),
        }),
      }),
    } as unknown as DatabaseClient;
    return {
      db,
      revoke() {
        revoked = true;
      },
      armReadGate(): (row: Row) => void {
        const gate = createDeferred<Row>();
        gateQueue.push(gate);
        return (row: Row) => gate.resolve(row);
      },
    };
  }

  it("does not publish an older fill's trusted active value over a newer fill's pending marker", async () => {
    const entry = entryWithStatus("active");
    const activeRow = { ...revokedRow(), status: "active" };
    const deactivatedRow = { ...revokedRow(), status: "deactivated" };
    const cacheKey = apiKeyCacheKey(TOKEN_KEY_HASH);
    const { kv, slot, writes, armCasGate } = gatedKV();
    const dbCtl = gatedDb(activeRow, deactivatedRow);

    // Fill A wins the install and suspends mid-verify: its Postgres verify
    // read has returned the pre-revocation snapshot, but its publish has
    // not run yet.
    const releaseAVerify = dbCtl.armReadGate();
    const promiseA = fillApiKeyCache(dbCtl.db, kv, TOKEN_KEY_HASH, entry);
    await flush();
    expect(JSON.parse(slot.get(cacheKey) ?? "{}")).toMatchObject({
      pendingVerification: true,
      status: "active",
    });

    // The revocation commits and its cache refresh lands the terminal entry,
    // overwriting A's pending marker...
    dbCtl.revoke();
    expect(await refreshApiKeyCache(dbCtl.db, kv, TOKEN_KEY_HASH)).toBe(true);
    expect(JSON.parse(slot.get(cacheKey) ?? "{}")).toMatchObject({ status: "deactivated" });

    // ...which Redis then evicts.
    await kv.delete(cacheKey);

    // Fill C read the same pre-revocation snapshot. It claims the emptied
    // slot with its own pending marker, its verify read sees the revocation,
    // and its repair CAS is suspended mid-flight — leaving C's pending
    // marker in the slot.
    const releaseCVerify = dbCtl.armReadGate();
    const promiseC = fillApiKeyCache(dbCtl.db, kv, TOKEN_KEY_HASH, entry);
    await flush();
    expect(JSON.parse(slot.get(cacheKey) ?? "{}")).toMatchObject({
      pendingVerification: true,
      status: "active",
    });
    const releaseCRepair = armCasGate();
    releaseCVerify(deactivatedRow);
    await flush();
    expect(JSON.parse(slot.get(cacheKey) ?? "{}")).toMatchObject({
      pendingVerification: true,
      status: "active",
    });

    // A's suspended verify resumes and tries to publish trusted active state
    // over the marker it finds in the slot. That marker is C's, not A's: the
    // publish must lose, and A must resolve against Postgres — which reports
    // the revocation.
    releaseAVerify(activeRow);
    const adoptedA = await promiseA;
    expect(adoptedA.status).toBe("deactivated");

    // No trusted non-terminal value may reach the slot after the
    // revocation's terminal write: readers would authorize from it.
    const trustedActiveWrites = writes.filter(({ value }) => {
      const parsed = JSON.parse(value) as CachedApiKey;
      return !parsed.pendingVerification && parsed.status === "active";
    });
    expect(trustedActiveWrites).toHaveLength(0);

    // C's repair converges the slot to the terminal state.
    releaseCRepair();
    const adoptedC = await promiseC;
    expect(adoptedC.status).toBe("deactivated");
    expect(JSON.parse(slot.get(cacheKey) ?? "{}")).toMatchObject({ status: "deactivated" });
  });

  it("installs distinct pending markers for distinct fills of the same snapshot", async () => {
    // The publish CAS is the only proof that a fill's own marker is still
    // the one in the slot. Two fills reading the same snapshot must
    // therefore never install byte-identical pending markers — otherwise
    // one fill's publish can be satisfied by the other's marker, which the
    // eviction race above turns into a trusted-active resurrection.
    const entry = entryWithStatus("active");
    const activeRow = { ...revokedRow(), status: "active" };
    const cacheKey = apiKeyCacheKey(TOKEN_KEY_HASH);
    const { kv, writes } = gatedKV();

    const first = await fillApiKeyCache(dbReturning(activeRow), kv, TOKEN_KEY_HASH, entry);
    // writes[0] is the install CAS, writes[1] the verified publish.
    const markerA = writes[0]?.value;
    expect(JSON.parse(markerA ?? "{}")).toMatchObject({
      pendingVerification: true,
      status: "active",
    });

    // Reset the slot so the second fill re-runs the full install path
    // against the same snapshot.
    await kv.delete(cacheKey);
    const second = await fillApiKeyCache(dbReturning(activeRow), kv, TOKEN_KEY_HASH, entry);
    const markerB = writes[2]?.value;

    expect(second).toBe(first);
    expect(JSON.parse(markerB ?? "{}")).toMatchObject({
      pendingVerification: true,
      status: "active",
    });
    expect(markerA).not.toBe(markerB);
  });
});
