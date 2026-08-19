"use client";

import { z } from "zod";

/**
 * Browser-side durability for the vault deposit IDEMPOTENCY KEY.
 *
 * `POST /v1/earn/vault-deposits` signs and RECORDS the transaction before it
 * broadcasts, so between the click and the chain there is a window where SDP
 * holds a signed transaction whose fate nobody knows yet. A retry inside that
 * window must carry the SAME key, or the chain will happily accept the same
 * transfer twice — there is no provider-side dedupe behind this route. A React
 * ref cannot do that job: it dies with the modal and with the tab's page load.
 *
 * This store deliberately holds ONLY the key. Tracking which deposits are in
 * flight used to live here too, and it was the wrong place: browser state
 * could not see a deposit signed in another tab, and it restored the previous
 * project's watches after a workspace switch. That moved to the server —
 * `GET /v1/earn/vault-deposits` — which is workspace-scoped by construction.
 * The key stays here because it is genuinely client-owned: the client mints it,
 * and it has to survive to be re-sent.
 *
 * `sessionStorage`, not `localStorage`: this is per-tab working state about a
 * transaction in flight, and it should die with the tab rather than resurface
 * days later in a different context.
 *
 * Every read fails soft. Storage throws outright in some privacy modes, and a
 * deposit must never be blocked because a browser refused to remember it — but
 * failing soft must not mean failing OPEN. A refusing store falls back to the
 * module-scope map below, which keeps the key stable for as long as the page
 * lives; what is lost there is durability across a reload, never the answer to
 * "is this the same request".
 */

const IDEMPOTENCY_STORE_KEY = "sdp:earn:vault-deposit:idempotency:v1";

/**
 * How long a minted key stays claimable for the same request, by DEFAULT.
 *
 * It has to comfortably outlast a retry — a customer re-pressing submit after a
 * timeout, or reloading a tab that hung — and it has to expire well before the
 * key could be mistaken for a NEW intent. A BROADCAST deposit is terminal within
 * ~90 seconds either way (a Solana blockhash expires, and the reconciliation
 * sweep fails the movement), so fifteen minutes is far past any live ambiguity
 * while still guaranteeing that depositing the same amount from the same wallet
 * again tomorrow is a second deposit rather than a replay of the first.
 *
 * That clock is WRONG for an approval hold, which is why `holdVaultDepositIdempotencyKey`
 * exists — see it for the reasoning.
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
 * This store is written by an older build of this same page as often as by the
 * current one, so its contents are untrusted JSON — the same reason
 * `earn-funding-wallets.ts` parses its rows and derives its row type from the
 * schema. `expiresAt` is OPTIONAL so an entry from a build that predates the
 * field keeps working under the default TTL instead of being dropped as
 * unrecognized; dropping it would mint a fresh key for a request already in
 * flight, which is the one outcome this module must never produce.
 *
 * `null` on `expiresAt` means "does not expire while this tab lives", which is
 * not the unbounded claim it looks like: the whole store is `sessionStorage`, so
 * the tab session is already the outer bound.
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
 * The two kinds are not comparable, in either direction that matters:
 *
 *   how many can exist — an EXPIRING entry is minted by typing a new amount, so
 *     it accumulates freely. A HELD entry exists only because a real POST was
 *     parked by the policy gate, so its count is bounded by actual approval
 *     requests a person raised in one tab: single digits in practice, and it
 *     falls as they resolve.
 *   what losing one costs — dropping an expiring entry costs at most a replay,
 *     which the API reports honestly as `replayed`. Dropping a HELD entry mints
 *     a fresh key on the next submit, which opens a SECOND approval request for
 *     the same intent and can deposit the customer's money twice.
 *
 * So a shared cap was the wrong shape: it traded the catastrophic failure for a
 * storage one. And the storage failure is not real at these sizes — an entry is
 * ~260 bytes, so even a thousand held entries is a couple of hundred KB against
 * a multi-megabyte quota. If a quota ever did refuse the write, `writeEntries`
 * already fails soft into `memoryEntries`, so the cost is durability across a
 * reload rather than a key that silently changed.
 *
 * The cap therefore governs expiring entries, and held entries eat into its
 * headroom: with the cap full of held keys only the newest expiring entry is
 * kept, which is the correct trade in the same direction.
 */
function withinStorageBound(entries: readonly StoredEntry[]): StoredEntry[] {
  const held = entries.filter(isHeldEntry);
  // Floor of ONE, not zero. Callers write the entry they just claimed as the
  // last element, so a budget of zero would evict the very key `claim` is about
  // to return — and a key that was handed out but never stored is one the next
  // call silently replaces, which is the failure this whole module exists to
  // prevent. Held entries already exceed the cap freely, so one more expiring
  // entry changes nothing about the bound's purpose.
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
 * A dead store must cost DURABILITY, never correctness. Re-deriving nothing and
 * minting a fresh key on each call would turn an ambiguous retry into a second
 * on-chain deposit — the precise failure this module exists to prevent — so the
 * degraded path still has to answer "is this the same request" for as long as
 * the page lives. Written on every save so it is warm the moment storage stops
 * answering mid-session.
 */
const memoryEntries = new Map<string, readonly StoredEntry[]>();

/**
 * Store keys whose LAST write failed to reach `sessionStorage` while reads
 * still work — the asymmetric failure a quota produces: `setItem` throws,
 * `getItem` keeps serving the stale previous state.
 *
 * That asymmetry is why "read storage when it answers" is not sufficient on
 * its own. Every write lands in `memoryEntries` unconditionally before the
 * storage attempt, so memory is always the newest complete snapshot; a
 * readable storage can only be EQUAL to it (the write succeeded) or OLDER (it
 * failed). Preferring readable-but-stale storage after a failed write is how a
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
 * every reused key (`?requestId=` pre-flight, `assertMovementIsOwnReplay`) and
 * why a fresh key's worst case is a second approval REQUEST awaiting a human,
 * never a silent second broadcast.
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
    // loaded), so the readable state is stale by construction — see the flag's
    // docstring.
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
    // losing the deposit — but a still-READABLE storage is now behind memory,
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
export function resetVaultDepositTrackingStateForTests(): void {
  memoryEntries.clear();
  storageDivergedKeys.clear();
}

/**
 * What makes two submissions the SAME request: the PROJECT, the strategy, the
 * wallet paying for it, and the amount. Change any one and it is a different
 * deposit, not a retry — which is exactly the distinction an idempotency key has
 * to encode.
 *
 * The project is in here for a reason that only shows up once the key is
 * durable. A custody config may be ORGANIZATION-level, so two projects can
 * resolve the same `custody_wallets` row; without the project, switching project
 * in one tab and re-submitting the same strategy and amount reuses the first
 * project's key. The API's replay lookup is keyed on
 * `(organization_id, request_id)`, so that reused key resolves the FIRST
 * project's movement — returning it as a replay instead of making the deposit.
 * A ref-scoped key never survived a project switch, so this only became
 * reachable when the key started outliving the component.
 */
export function vaultDepositRequestFingerprint(input: {
  /** `null` only before a project resolves; it still discriminates. */
  projectId: string | null;
  strategyId: string;
  custodyWalletId: string;
  amount: string;
}): string {
  return JSON.stringify([input.projectId, input.strategyId, input.custodyWalletId, input.amount]);
}

/**
 * The idempotency key for this request, minting and persisting one the first
 * time. Called again for the same fingerprint — a retry, or the same form after
 * a reload — it returns the SAME key, which is what makes the retry a retry.
 */
export function claimVaultDepositIdempotencyKey(fingerprint: string): string {
  const entries = readEntries(IDEMPOTENCY_STORE_KEY, IDEMPOTENCY_TTL_MS);
  const existing = entries.find((entry) => entry.id === fingerprint);
  if (existing) return existing.value;

  const key = crypto.randomUUID();
  writeEntries(IDEMPOTENCY_STORE_KEY, [
    ...entries.filter((entry) => entry.id !== fingerprint),
    { id: fingerprint, value: key, createdAt: Date.now() },
  ]);
  return key;
}

/**
 * Pin a key for as long as an approval hold on it is live.
 *
 * The default TTL is calibrated to a BROADCAST deposit: a blockhash expires in
 * ~90 seconds and the sweep settles the movement, so fifteen minutes is far
 * past any live ambiguity. An approval hold answers to no such clock — a human
 * has to act, and that can take hours. Letting the key lapse there would be the
 * worst possible timing: the operation is still pending server-side under that
 * exact value, replay detection is keyed on it, and a resubmit with a fresh key
 * opens a SECOND approval request for the same intent. Approve both and the
 * customer deposits twice.
 *
 * So an approval hold suspends expiry rather than extending it by a guess.
 *
 * Suspending expiry needs its own way OUT, or the key outlives the approval and
 * a later legitimate deposit of the same amount from the same wallet silently
 * replays the approved one instead of moving money. The tab session is not a
 * tight enough bound for that. Two things end a hold:
 *   - the API answering (`releaseVaultDepositIdempotencyKey`), as on any path;
 *   - the write behind the hold becoming visible — the modal checks
 *     `isVaultDepositIdempotencyKeyHeld` and asks the server whether a movement
 *     exists for the key before reusing it, because a movement means the key is
 *     spent.
 * A REJECTED approval produces no movement, so its key stays until the next
 * submit reuses it and the API answers 403 "denied by policy" — visible, and a
 * 4xx retires the key, so the attempt after that mints a fresh one.
 */
export function holdVaultDepositIdempotencyKey(fingerprint: string): void {
  const entries = readEntries(IDEMPOTENCY_STORE_KEY, IDEMPOTENCY_TTL_MS);
  const held = entries.find((entry) => entry.id === fingerprint);
  if (!held) return;
  writeEntries(IDEMPOTENCY_STORE_KEY, [
    ...entries.filter((entry) => entry.id !== fingerprint),
    { ...held, expiresAt: null },
  ]);
}

/**
 * Whether this request's key is pinned by a live approval hold.
 *
 * A held key has no expiry, which makes it the one entry that cannot age out on
 * its own — so the caller has to establish whether the hold is still live before
 * reusing it. `fetchEarnVaultDepositByRequestId` is that check: once a movement
 * exists for the key, the write behind the hold has HAPPENED and the key is
 * spent. See the modal's submit path.
 */
export function isVaultDepositIdempotencyKeyHeld(fingerprint: string): boolean {
  const entry = readEntries(IDEMPOTENCY_STORE_KEY, IDEMPOTENCY_TTL_MS).find(
    (candidate) => candidate.id === fingerprint
  );
  return entry?.expiresAt === null;
}

/**
 * Retire a key once the API has ANSWERED for it.
 *
 * Only call this on a definitive answer. A key that is released while its
 * request may still have been recorded turns the next retry into a second
 * deposit; a key that is held too long only costs a replay, which the API
 * reports honestly as `replayed`. The asymmetry is why the TTL above is the
 * backstop and this is the fast path.
 */
export function releaseVaultDepositIdempotencyKey(fingerprint: string): void {
  const entries = readEntries(IDEMPOTENCY_STORE_KEY, IDEMPOTENCY_TTL_MS);
  if (!entries.some((entry) => entry.id === fingerprint)) return;
  writeEntries(
    IDEMPOTENCY_STORE_KEY,
    entries.filter((entry) => entry.id !== fingerprint)
  );
}
