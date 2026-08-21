"use client";

import { z } from "zod";

/**
 * Browser-side durability for a value-moving IDEMPOTENCY KEY, per request
 * fingerprint — the machinery behind `earn-vault-deposit-tracking.ts` and
 * `earn-vault-withdraw-tracking.ts`, extracted because the two flows share
 * every rule and two copies of a double-spend guard is how one drifts.
 *
 * The vault money routes sign and RECORD a transaction before broadcasting it,
 * so between the click and the chain there is a window where SDP holds signed
 * bytes whose fate nobody knows yet. A retry inside that window must carry the
 * SAME key, or the chain will happily accept the same transfer twice — there
 * is no provider-side dedupe behind these routes. A React ref cannot do that
 * job: it dies with the modal and with the tab's page load.
 *
 * Each store holds ONLY keys. Which movements are in flight lives on the
 * server (`GET /v1/earn/vault-deposits` / `/vault-withdrawals`), which is
 * workspace-scoped by construction; browser state could not see a transaction
 * signed in another tab and restored the previous project's watches after a
 * workspace switch. The key stays here because it is genuinely client-owned:
 * the client mints it, and it has to survive to be re-sent.
 *
 * `sessionStorage`, not `localStorage`: per-tab working state about a
 * transaction in flight should die with the tab rather than resurface days
 * later in a different context.
 *
 * Every read fails soft — storage throws outright in some privacy modes, and a
 * money movement must never be blocked because a browser refused to remember
 * it — but failing soft must not mean failing OPEN. A refusing store falls
 * back to the module-scope map below, which keeps the key stable for as long
 * as the page lives; what is lost there is durability across a reload, never
 * the answer to "is this the same request".
 */

/**
 * How long a minted key stays claimable for the same request, by DEFAULT.
 *
 * It has to comfortably outlast a retry — a customer re-pressing submit after
 * a timeout, or reloading a tab that hung — and it has to expire well before
 * the key could be mistaken for a NEW intent. A BROADCAST transaction is
 * terminal within ~90 seconds either way (a Solana blockhash expires, and the
 * reconciliation sweep fails the movement), so fifteen minutes is far past any
 * live ambiguity while still guaranteeing that moving the same amount from the
 * same wallet again tomorrow is a second movement rather than a replay of the
 * first.
 *
 * That clock is WRONG for an approval hold, which is why `hold` exists — see it
 * for the reasoning.
 */
const IDEMPOTENCY_TTL_MS = 15 * 60_000;

/**
 * Cap on EXPIRING entries, so a long session of typing amounts cannot grow the
 * store without limit. Held entries are exempt — see `withinStorageBound`.
 */
const MAX_STORED_ENTRIES = 20;

/**
 * One stored entry, validated at the boundary rather than narrowed by hand.
 *
 * A store is written by an older build of this same page as often as by the
 * current one, so its contents are untrusted JSON. `expiresAt` is OPTIONAL so
 * an entry from a build that predates the field keeps working under the
 * default TTL instead of being dropped as unrecognized; dropping it would mint
 * a fresh key for a request already in flight, which is the one outcome this
 * module must never produce.
 *
 * `null` on `expiresAt` means "does not expire while this tab lives", which is
 * not the unbounded claim it looks like: the whole store is `sessionStorage`,
 * so the tab session is already the outer bound.
 */
const storedEntrySchema = z.object({
  /** The request fingerprint this key belongs to. */
  id: z.string().min(1),
  value: z.string().min(1),
  createdAt: z.number().finite(),
  expiresAt: z.union([z.number().finite(), z.null()]).optional(),
});

type StoredEntry = z.infer<typeof storedEntrySchema>;

/** A held entry is one an approval is still waiting on; it has no expiry. */
function isHeldEntry(entry: StoredEntry): boolean {
  return entry.expiresAt === null;
}

/** Whether an entry is still claimable, honouring its own expiry over the default. */
function isLiveEntry(entry: StoredEntry, now: number, ttlMs: number): boolean {
  if (entry.expiresAt !== undefined) {
    return entry.expiresAt === null || now < entry.expiresAt;
  }
  return now - entry.createdAt < ttlMs;
}

/**
 * Bound the store — by evicting EXPIRING entries only. A held entry is never
 * dropped.
 *
 * The two kinds are not comparable, in either direction that matters: an
 * expiring entry is minted by typing a new amount and costs at most a replay
 * if dropped, while a HELD entry exists only because a real POST was parked by
 * the policy gate — dropping it mints a fresh key on the next submit, which
 * opens a SECOND approval request for the same intent and can move the
 * customer's money twice. Full rationale in the deposit module's history; the
 * floor of ONE exists because callers write the entry they just claimed as the
 * last element, and a budget of zero would evict the very key `claim` is about
 * to return.
 */
function withinStorageBound(entries: readonly StoredEntry[]): StoredEntry[] {
  const held = entries.filter(isHeldEntry);
  const room = Math.max(1, MAX_STORED_ENTRIES - held.length);
  const expiring = entries.filter((entry) => !isHeldEntry(entry));
  const keptExpiring = expiring.slice(-room);

  // Filter the original array so insertion order — newest last — survives.
  const kept = new Set<StoredEntry>([...held, ...keptExpiring]);
  return entries.filter((entry) => kept.has(entry));
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
 *
 * A dead store must cost DURABILITY, never correctness. Re-deriving nothing
 * and minting a fresh key on each call would turn an ambiguous retry into a
 * second on-chain movement — the precise failure this module exists to
 * prevent — so the degraded path still has to answer "is this the same
 * request" for as long as the page lives. Written on every save so it is warm
 * the moment storage stops answering mid-session.
 */
const memoryEntries = new Map<string, readonly StoredEntry[]>();

/**
 * Store keys whose LAST write failed to reach `sessionStorage` while reads
 * still work — the asymmetric failure a quota produces: `setItem` throws,
 * `getItem` keeps serving the stale previous state.
 *
 * Every write lands in `memoryEntries` unconditionally before the storage
 * attempt, so memory is always the newest complete snapshot; a readable
 * storage can only be EQUAL to it (the write succeeded) or OLDER (it failed).
 * Preferring readable-but-stale storage after a failed write is how a
 * just-claimed key vanished on the next read — minting a fresh key for a
 * request already in flight — and how a hold marker written only to memory was
 * lost, letting an executed approval present as a fresh submission.
 *
 * So: a failed write flips the key to memory-preferred; the next successful
 * write means storage has caught up and flips it back. While storage is
 * healthy it stays the authority, so an external clear genuinely clears and a
 * state written by a previous page load is honoured.
 *
 * The residual, stated honestly: memory dies with the page, so a failed write
 * followed by a RELOAD serves the stale storage. Nothing client-side can close
 * that — durability was refused — which is exactly why the server double-checks
 * every reused key.
 */
const storageDivergedKeys = new Set<string>();

/**
 * `usable: false` means this browser will not hand anything back at all —
 * distinct from a usable store that simply holds nothing under this key. Only
 * the first falls through to memory: a store that answers is the authority, so
 * clearing it genuinely clears, rather than being undone by a warm shadow copy.
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

function readEntries(storeKey: string, ttlMs: number): StoredEntry[] {
  let parsed: unknown;
  if (storageDivergedKeys.has(storeKey)) {
    // Storage is behind memory for this key (a write failed after the page
    // loaded), so the readable state is stale by construction.
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

  // Parsed per entry at the boundary: a half-recognized entry is dropped, never
  // coerced.
  const now = Date.now();
  return parsed.flatMap((entry) => {
    const candidate = storedEntrySchema.safeParse(entry);
    if (!candidate.success) return [];
    return isLiveEntry(candidate.data, now, ttlMs) ? [candidate.data] : [];
  });
}

function writeEntries(storeKey: string, entries: readonly StoredEntry[]): void {
  const bounded = withinStorageBound(entries);
  // Memory first and unconditionally: it is the tier that cannot fail, and it
  // has to already hold the value if the store refuses the very next write.
  memoryEntries.set(storeKey, bounded);

  const store = storage();
  if (!store) return;
  try {
    store.setItem(storeKey, JSON.stringify(bounded));
    // Storage has caught up with memory; it is the authority again.
    storageDivergedKeys.delete(storeKey);
  } catch {
    // Quota or a refusing store. Losing the durability is strictly better than
    // losing the movement — but a still-READABLE storage is now behind memory,
    // and serving it would un-write the entry we just wrote. Flip this key to
    // memory-preferred until a write lands.
    storageDivergedKeys.add(storeKey);
  }
}

/**
 * Test-only: clear the module-scope tiers so specs are order-independent.
 * Production never calls this — the whole point of the tiers is surviving
 * everything short of the page itself.
 *
 * @internal
 */
export function resetIdempotencyKeyStoresForTests(): void {
  memoryEntries.clear();
  storageDivergedKeys.clear();
}

export interface IdempotencyKeyStore {
  /**
   * The idempotency key for this request, minting and persisting one the first
   * time. Called again for the same fingerprint — a retry, or the same form
   * after a reload — it returns the SAME key, which is what makes the retry a
   * retry.
   */
  claim(fingerprint: string): string;
  /**
   * Pin a key for as long as an approval hold on it is live: an approval
   * answers to a human and can take hours, far past the default TTL, and a
   * lapsed key there resubmits into a SECOND approval request for one intent.
   * The way OUT of a hold is the caller's: ask the server whether a movement
   * exists for the key before reusing it (a movement means the key is spent),
   * or a definitive API answer releasing it.
   */
  hold(fingerprint: string): void;
  /** Whether this request's key is pinned by a live approval hold. */
  isHeld(fingerprint: string): boolean;
  /**
   * Retire a key once the API has ANSWERED for it. Only call this on a
   * definitive answer: a key released while its request may still have been
   * recorded turns the next retry into a second movement; a key held too long
   * only costs a replay, which the API reports honestly as `replayed`.
   */
  release(fingerprint: string): void;
}

type HeldIdempotencyKeyResolution =
  | { kind: "key"; key: string; wasHeld: boolean }
  | { kind: "aborted" }
  | { kind: "unavailable" };

type HeldIdempotencyKeyLookup = { kind: "found" } | { kind: "absent" } | { kind: "unavailable" };

/**
 * Resolve a reusable key without guessing whether an approval already spent it.
 *
 * `wasHeld` is load-bearing: an approval can execute between the preflight and
 * POST, so the response must distinguish that absorbed race from a fresh
 * submission. Both vault money flows use this exact lifecycle.
 */
export async function resolveHeldIdempotencyKey(
  store: IdempotencyKeyStore,
  fingerprint: string,
  signal: AbortSignal,
  fetchRecorded: (key: string) => Promise<HeldIdempotencyKeyLookup>
): Promise<HeldIdempotencyKeyResolution> {
  const key = store.claim(fingerprint);
  if (!store.isHeld(fingerprint)) return { kind: "key", key, wasHeld: false };

  const recorded = await fetchRecorded(key);
  if (signal.aborted) return { kind: "aborted" };
  if (recorded.kind === "unavailable") return { kind: "unavailable" };
  if (recorded.kind === "absent") return { kind: "key", key, wasHeld: true };

  store.release(fingerprint);
  return { kind: "key", key: store.claim(fingerprint), wasHeld: false };
}

type IdempotencyKeyOutcome =
  | { ok: true; status: number; data: { kind: string } }
  | { ok: false; status: number | null };

/**
 * Whether the API has ANSWERED for an idempotency key, which is the only
 * condition under which retiring it is safe. Shared by both vault money flows;
 * structural over the fetch result so each keeps its own response type.
 *
 * The asymmetry drives every branch: a key released too early turns the next
 * retry into a SECOND on-chain movement, while a key held too long costs at
 * worst a replay the API reports honestly as `replayed`.
 *
 * - An approval hold IS an answer, but the write it gates has not been decided
 *   and is still keyed by this value — resubmitting under a fresh key would
 *   open a second approval request for the same intent. Not retiring; the
 *   caller pins it instead.
 * - Only a 4xx proves nothing was written; in the idempotency-conflict case
 *   releasing is also the escape hatch, or a collided key collides forever.
 * - Everything else might have written: `status === null` is a transport
 *   failure, a 2xx whose body did not parse is an answer nobody could read,
 *   and a 5xx is the dangerous one — a gateway timing out downstream of an API
 *   that already recorded and broadcast looks exactly like a provider being
 *   unavailable before it did.
 */
function answerRetiresIdempotencyKey(result: IdempotencyKeyOutcome): boolean {
  if (result.ok) {
    return result.data?.kind !== "approval_pending";
  }
  return result.status !== null && result.status >= 400 && result.status < 500;
}

/** Apply the shared retire, hold, or preserve rule to one API answer. */
export function applyIdempotencyKeyOutcome(
  store: IdempotencyKeyStore,
  fingerprint: string,
  result: IdempotencyKeyOutcome
): void {
  if (answerRetiresIdempotencyKey(result)) {
    store.release(fingerprint);
    return;
  }
  if (result.ok && result.data.kind === "approval_pending") {
    store.hold(fingerprint);
  }
}

/** One per money flow, each under its own versioned `sessionStorage` key. */
export function createIdempotencyKeyStore(storeKey: string): IdempotencyKeyStore {
  return {
    claim(fingerprint) {
      const entries = readEntries(storeKey, IDEMPOTENCY_TTL_MS);
      const existing = entries.find((entry) => entry.id === fingerprint);
      if (existing) return existing.value;

      const key = crypto.randomUUID();
      writeEntries(storeKey, [
        ...entries.filter((entry) => entry.id !== fingerprint),
        { id: fingerprint, value: key, createdAt: Date.now() },
      ]);
      return key;
    },

    hold(fingerprint) {
      const entries = readEntries(storeKey, IDEMPOTENCY_TTL_MS);
      const held = entries.find((entry) => entry.id === fingerprint);
      if (!held) return;
      writeEntries(storeKey, [
        ...entries.filter((entry) => entry.id !== fingerprint),
        { ...held, expiresAt: null },
      ]);
    },

    isHeld(fingerprint) {
      const entry = readEntries(storeKey, IDEMPOTENCY_TTL_MS).find(
        (candidate) => candidate.id === fingerprint
      );
      return entry?.expiresAt === null;
    },

    release(fingerprint) {
      const entries = readEntries(storeKey, IDEMPOTENCY_TTL_MS);
      if (!entries.some((entry) => entry.id === fingerprint)) return;
      writeEntries(
        storeKey,
        entries.filter((entry) => entry.id !== fingerprint)
      );
    },
  };
}
