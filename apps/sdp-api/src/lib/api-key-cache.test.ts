/**
 * Regression test for the CAS-exhaustion fallback in fillApiKeyCache: when
 * every write attempt loses (each slot read saw nothing, but a competing
 * write landed before our CAS), the losing fill must re-read the slot and
 * authenticate against whatever authoritative state won — not fall back to
 * its own pre-race snapshot. Otherwise a revocation that lands during those
 * windows is ignored by the very request that raced it.
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
  };
}

/**
 * Models the worst-case interleaving: every read during the fill loop sees
 * an empty slot, every CAS loses to a competing writer, and by the time the
 * loop has exhausted its attempts a revocation tombstone occupies the slot.
 */
function contendedStore(finalValue: string): KVStore {
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

describe("fillApiKeyCache under CAS exhaustion", () => {
  it("adopts the revoked state that won the slot instead of its own stale snapshot", async () => {
    const revoked = entryWithStatus("revoked");
    const kv = contendedStore(JSON.stringify(revoked));

    const adopted = await fillApiKeyCache(kv, KEY_HASH, entryWithStatus("active"));

    expect(adopted.status).toBe("revoked");
  });

  it("falls back to its own snapshot only when the slot is empty even after losing", async () => {
    let reads = 0;
    const kv = {
      ...contendedStore(""),
      get: async () => {
        reads += 1;
        return null;
      },
    } as KVStore;

    const adopted = await fillApiKeyCache(kv, KEY_HASH, entryWithStatus("active"));
    expect(adopted.status).toBe("active");
    expect(reads).toBeGreaterThanOrEqual(3);
  });
});
