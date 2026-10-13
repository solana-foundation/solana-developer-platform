"use client";

import { z } from "zod";
import { type ApiAnswer, answerRetiresKey, storageFingerprint } from "./idempotency";

/**
 * Browser-side durability for an IDEMPOTENCY KEY, per request fingerprint: the
 * machinery behind every dashboard key holder (HOO-1918). The Earn vault
 * deposit and exits, Private Channels movements, Payments transfers and
 * batches, `dashboard-fetch`'s per-action keys and the per-input values of
 * {@link createActionMemo} (server-action keys, frozen payment-request
 * expiries) all keep their keys here, under one rule (`answerRetiresKey`).
 *
 * A retry must carry the SAME key, or the API takes it as a second request
 * and can move money twice. A React ref cannot do that job: it dies with the
 * modal and with the tab's page load. So a key is kept in `sessionStorage` per
 * tab (not `localStorage`: working state about a request in flight should die
 * with the tab), from the moment it is claimed until an answer retires it, and
 * it is never evicted before then.
 */

/**
 * One stored entry, validated at the boundary. Entries written by an earlier
 * build carry extra fields (an expiry, a pending mark); they are read as plain
 * kept keys, so an upgrade never drops a key for a request in flight.
 */
const storedEntrySchema = z.object({
  /** The request fingerprint this key belongs to. */
  id: z.string().min(1),
  value: z.string().min(1),
});

type StoredEntry = z.infer<typeof storedEntrySchema>;

/**
 * The signed-in user and organization every store's entries belong to. A key
 * minted by one user is refused (422) when another user sends it, and an
 * unanswered key is kept until answered, so a second user in the same tab
 * would be stuck on the first user's key. Namespacing keeps each user's and
 * org's entries apart, and keeps the first user's unanswered keys for when
 * they sign back in.
 */
let keyScope = "";

/**
 * Sets the scope from the dashboard's signed-in user and org
 * (`getDashboardCacheScopeKey`). The dashboard workspace provider calls it as
 * it renders, before any child reads a key.
 */
export function setIdempotencyKeyScope(scope: string): void {
  keyScope = scope;
}

function scopedKey(storeKey: string): string {
  return keyScope ? `${storeKey}:${keyScope}` : storeKey;
}

function storage(): Storage | null {
  try {
    // Both the property access and the availability check can throw: some
    // privacy modes expose the object and refuse every operation on it.
    if (typeof window === "undefined") return null;
    const store = window.sessionStorage;
    return store ?? null;
  } catch {
    return null;
  }
}

/**
 * The in-memory tier, authoritative only when the browser refuses to store.
 * A dead store must cost durability, never correctness: the degraded path
 * still answers "is this the same request" for as long as the page lives.
 * Written on every save so it is warm the moment storage stops answering.
 */
const memoryEntries = new Map<string, readonly StoredEntry[]>();

/**
 * Store keys whose last write failed to reach `sessionStorage` while reads
 * still work, the asymmetric failure a quota produces. Memory is written first
 * on every save, so after a failed write the readable storage is stale and
 * memory is preferred until a write lands again. While storage is healthy it
 * stays the authority, so an external clear genuinely clears. The `FloorMemo`
 * stores below share this set under their own keys.
 */
const storageDivergedKeys = new Set<string>();

/**
 * `usable: false` means this browser will not hand anything back at all,
 * distinct from a usable store that holds nothing under this key. Only the
 * first falls through to memory.
 */
function readStoredText(
  storeKey: string
): { usable: true; raw: string | null } | { usable: false } {
  const store = storage();
  if (!store) return { usable: false };
  try {
    return { usable: true, raw: store.getItem(storeKey) };
  } catch {
    return { usable: false };
  }
}

function readEntries(unscopedKey: string): StoredEntry[] {
  const storeKey = scopedKey(unscopedKey);
  let parsed: unknown;
  if (storageDivergedKeys.has(storeKey)) {
    parsed = memoryEntries.get(storeKey) ?? [];
  } else {
    const stored = readStoredText(storeKey);
    if (!stored.usable) {
      parsed = memoryEntries.get(storeKey) ?? [];
    } else if (stored.raw === null) {
      return [];
    } else {
      try {
        parsed = JSON.parse(stored.raw);
      } catch {
        return [];
      }
    }
  }
  if (!Array.isArray(parsed)) return [];
  // Parsed per entry: a half-recognized entry is dropped, never coerced.
  return parsed.flatMap((entry) => {
    const candidate = storedEntrySchema.safeParse(entry);
    return candidate.success ? [candidate.data] : [];
  });
}

function writeEntries(unscopedKey: string, entries: readonly StoredEntry[]): boolean {
  const storeKey = scopedKey(unscopedKey);
  // Memory first and unconditionally: it has to hold the value if the store
  // refuses this write.
  memoryEntries.set(storeKey, entries);
  const store = storage();
  if (!store) return false;
  try {
    store.setItem(storeKey, JSON.stringify(entries));
    storageDivergedKeys.delete(storeKey);
    return true;
  } catch {
    // Quota or a refusing store: storage is now behind memory for this key.
    storageDivergedKeys.add(storeKey);
    return false;
  }
}

/**
 * Test-only: clear the module-scope tiers so specs are order-independent.
 *
 * @internal
 */
export function resetIdempotencyKeyStoresForTests(): void {
  memoryEntries.clear();
  storageDivergedKeys.clear();
  keyScope = "";
}

export interface IdempotencyKeyStore {
  /** Whether a key is kept for this request: an earlier attempt left it unretired. */
  has(fingerprint: string): boolean;
  /**
   * The request's key: the one kept for it, or a new one minted the first
   * time, and written to storage either way. `persisted: false` means the
   * browser refused the write, so a reload would lose the key; a money route
   * must not send then.
   *
   * @param mint - Makes the value the first time; a fresh UUID by default.
   */
  claim(fingerprint: string, mint?: () => string): { key: string; persisted: boolean };
  /** Retires the key: the next submit of this request is a new action. */
  release(fingerprint: string): void;
}

/** One per flow, each under its own versioned `sessionStorage` key. */
export function createIdempotencyKeyStore(storeKey: string): IdempotencyKeyStore {
  return {
    has(fingerprint) {
      return readEntries(storeKey).some((entry) => entry.id === fingerprint);
    },

    claim(fingerprint, mint = () => crypto.randomUUID()) {
      const entries = readEntries(storeKey);
      const existing = entries.find((entry) => entry.id === fingerprint);
      const key = existing?.value ?? mint();
      // Written again for a kept key too, so `persisted` describes this claim.
      const persisted = writeEntries(storeKey, [
        ...entries.filter((entry) => entry.id !== fingerprint),
        { id: fingerprint, value: key },
      ]);
      return { key, persisted };
    },

    release(fingerprint) {
      const entries = readEntries(storeKey);
      if (!entries.some((entry) => entry.id === fingerprint)) return;
      writeEntries(
        storeKey,
        entries.filter((entry) => entry.id !== fingerprint)
      );
    },
  };
}

/**
 * Applies the one rule to an answer: a success, a replay or a 422 retires the
 * request's key; anything else keeps it for the retry.
 *
 * @returns Whether the key was retired.
 */
export function settleIdempotencyKey(
  store: IdempotencyKeyStore,
  fingerprint: string,
  answer: ApiAnswer
): boolean {
  if (!answerRetiresKey(answer)) return false;
  store.release(fingerprint);
  return true;
}

/**
 * A bounded per-tab memo of the floor each in-flight fingerprint's key was
 * MINTED with. The fingerprint deliberately carries the user's TOLERANCE, not
 * the quote-derived floor (a floor moves with the live rate, and a fingerprint
 * must be reproducible from user input after a reload) — but the API's own
 * idempotency fingerprint includes the floor and refuses a replay whose floor
 * changed, so a held key must resubmit the exact floor it first carried. Same
 * tiers as the key store: `sessionStorage` so it survives the reload the held
 * key survives, memory when storage is refused, and a hard bound so an
 * abandoned tab cannot grow it without limit.
 */
export interface FloorMemo {
  /** Record the floor `fingerprint`'s key is being submitted with. */
  remember(fingerprint: string, floor: string | null): void;
  /**
   * A string floor, `null` for "deliberately none", or `undefined` when
   * nothing is remembered (evicted, another tab, storage refused) — the caller
   * then falls back to a fresh derivation, and the server's own fingerprint
   * remains the last line.
   */
  recall(fingerprint: string): string | null | undefined;
  /** Drop a retired key's floor so the next fresh derivation cannot inherit it. */
  forget(fingerprint: string): void;
  /** Test-only. @internal */
  resetForTests(): void;
}

const FLOOR_MEMO_BOUND = 32;

/**
 * One per money flow, each under its own versioned `sessionStorage` key.
 *
 * Reads and writes honour the same quota-divergence rule as the key store
 * above: a floor `setItem()` that throws while `getItem()` still answers is a
 * PARTIAL write — the readable storage is now behind the memory snapshot the
 * write did reach, and serving it would un-remember the floor a live key was
 * just minted with (the retry then reads `unavailable` and stops). So a failed write flips this storage key to memory-preferred until
 * a later write lands and re-synchronizes the full snapshot — including
 * `forget()`, whose removal must not resurface from stale storage.
 */
export function createFloorMemo(unscopedKey: string): FloorMemo {
  type Entries = Record<string, string | null>;
  const memories = new Map<string, Entries>();

  function read(): Entries {
    const storageKey = scopedKey(unscopedKey);
    const memory = memories.get(storageKey) ?? {};
    if (storageDivergedKeys.has(storageKey)) {
      // Storage is behind memory for this key (a write failed after the page
      // loaded), so the readable state is stale by construction.
      return { ...memory };
    }
    try {
      const raw = window.sessionStorage.getItem(storageKey);
      if (raw === null) return {};
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
      const entries: Entries = {};
      for (const [key, value] of Object.entries(parsed)) {
        if (typeof value === "string" || value === null) entries[key] = value;
      }
      return entries;
    } catch {
      return { ...memory };
    }
  }

  function write(entries: Entries): void {
    const storageKey = scopedKey(unscopedKey);
    memories.set(storageKey, { ...entries });
    try {
      window.sessionStorage.setItem(storageKey, JSON.stringify(entries));
      // Storage has caught up with memory; it is the authority again.
      storageDivergedKeys.delete(storageKey);
    } catch {
      // Quota or a refusing store. The memory tier above still serves this
      // tab's lifetime — and since a readable storage is now BEHIND it, this
      // key is memory-preferred until a write lands (see the divergence rule
      // on this store).
      storageDivergedKeys.add(storageKey);
    }
  }

  return {
    remember(fingerprint, floor) {
      const entries = read();
      delete entries[fingerprint];
      entries[fingerprint] = floor;
      const keys = Object.keys(entries);
      for (const stale of keys.slice(0, Math.max(0, keys.length - FLOOR_MEMO_BOUND))) {
        delete entries[stale];
      }
      write(entries);
    },
    recall(fingerprint) {
      const entries = read();
      return fingerprint in entries ? entries[fingerprint] : undefined;
    },
    forget(fingerprint) {
      const entries = read();
      delete entries[fingerprint];
      write(entries);
    },
    resetForTests() {
      const storageKey = scopedKey(unscopedKey);
      memories.clear();
      storageDivergedKeys.delete(storageKey);
      try {
        window.sessionStorage.removeItem(storageKey);
      } catch {
        // No storage in this environment; the memory tier is already clear.
      }
    },
  };
}

export interface ActionMemo<T> {
  /**
   * The value this input was first sent with, or `build()`'s, remembered.
   * Call it once per send, right before it.
   */
  valueFor(input: string, build: () => T): T;
  /** Records the send's answer: one that retires the key forgets the value. */
  settle(input: string, answer: ApiAnswer): void;
}

/**
 * What one user action was first sent with (its Idempotency-Key, or a value
 * read from the clock), per form input, kept in an {@link IdempotencyKeyStore}
 * until the action's answer retires it. The same input finds the same value
 * after an edit and back (A to B to A) and after a reload, so a retry resends
 * the first attempt's request. Inputs are stored as digests
 * ({@link storageFingerprint}), so form contents never sit in storage; values
 * are stored as JSON. A store that refuses writes keeps the value in memory for
 * this page, and the send still goes out: no caller is a money route.
 *
 * @param storeKey - The `sessionStorage` key.
 * @param schema - What a stored value must be; anything else is rebuilt.
 */
export function createActionMemo<T>(storeKey: string, schema: z.ZodType<T>): ActionMemo<T> {
  const store = createIdempotencyKeyStore(storeKey);
  const decode = (raw: string): { data: T } | null => {
    try {
      const parsed = schema.safeParse(JSON.parse(raw));
      return parsed.success ? parsed : null;
    } catch {
      return null;
    }
  };
  return {
    valueFor(input, build) {
      const fingerprint = storageFingerprint(input);
      const mint = () => JSON.stringify(build());
      let remembered = decode(store.claim(fingerprint, mint).key);
      if (!remembered) {
        store.release(fingerprint);
        remembered = decode(store.claim(fingerprint, mint).key);
      }
      if (!remembered) throw new Error(`${storeKey}: build() made a value its schema rejects`);
      return remembered.data;
    },

    settle(input, answer) {
      settleIdempotencyKey(store, storageFingerprint(input), answer);
    },
  };
}
