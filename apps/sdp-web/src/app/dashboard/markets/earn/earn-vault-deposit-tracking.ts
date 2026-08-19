"use client";

/**
 * Browser-side durability for a vault deposit that is in the air.
 *
 * `POST /v1/earn/vault-deposits` signs and RECORDS the transaction before it
 * broadcasts, so between the click and the chain there is a window where SDP
 * holds a signed transaction whose fate nobody knows yet. Two things have to
 * outlive the modal for that window to be survivable, and a React ref outlives
 * neither a close nor a reload:
 *
 *   the idempotency key   — without it a retry after an ambiguous send mints a
 *                           fresh key, and the chain will happily accept the
 *                           same transfer twice. There is no provider-side
 *                           dedupe behind this route to catch that.
 *   the movement id       — without it the deposit stops being pollable, and
 *                           the only thing left to tell a customer about their
 *                           money is "check the explorer".
 *
 * `sessionStorage`, not `localStorage`: this is per-tab working state about a
 * transaction in flight, and it should die with the tab rather than resurface
 * days later in a different context. The cost is that a deposit made in one tab
 * is not watched in another — acceptable while there is no movement-list
 * endpoint to recover from (the custodial withdrawal path recovers from its
 * ledger list instead; see `EarnWithdrawalLedgerRecovery`).
 *
 * Every read fails soft. Storage throws outright in some privacy modes, and a
 * deposit must never be blocked because a browser refused to remember it — the
 * fallback is exactly today's in-memory behaviour, not an error.
 */

const IDEMPOTENCY_STORE_KEY = "sdp:earn:vault-deposit:idempotency:v1";
const WATCH_STORE_KEY = "sdp:earn:vault-deposit:watch:v1";

/**
 * How long a minted key stays claimable for the same request.
 *
 * It has to comfortably outlast a retry — a customer re-pressing submit after a
 * timeout, or reloading a tab that hung — and it has to expire well before the
 * key could be mistaken for a NEW intent. A recorded deposit is terminal within
 * ~90 seconds either way (a Solana blockhash expires, and the reconciliation
 * sweep fails the movement), so fifteen minutes is far past any live ambiguity
 * while still guaranteeing that depositing the same amount from the same wallet
 * again tomorrow is a second deposit rather than a replay of the first.
 */
const IDEMPOTENCY_TTL_MS = 15 * 60_000;

/** A watch outlives a reload, not a working day; the sweep settles in minutes. */
const WATCH_TTL_MS = 12 * 60 * 60_000;

/** Bounded so a long session cannot grow the store without limit. */
const MAX_STORED_ENTRIES = 20;

interface StoredEntry {
  /** Request fingerprint for a key, movement id for a watch. */
  id: string;
  value: string;
  createdAt: number;
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

function readEntries(storeKey: string, ttlMs: number): StoredEntry[] {
  const store = storage();
  if (!store) return [];
  let raw: string | null;
  try {
    raw = store.getItem(storeKey);
  } catch {
    return [];
  }
  if (!raw) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  // Validate every field rather than trusting the shape. This store is written
  // by an older build of this same page as often as by the current one, and a
  // half-recognized entry must be dropped, never coerced.
  const now = Date.now();
  return parsed.filter((entry): entry is StoredEntry => {
    if (!entry || typeof entry !== "object") return false;
    const candidate = entry as Partial<StoredEntry>;
    return (
      typeof candidate.id === "string" &&
      candidate.id.length > 0 &&
      typeof candidate.value === "string" &&
      candidate.value.length > 0 &&
      typeof candidate.createdAt === "number" &&
      Number.isFinite(candidate.createdAt) &&
      now - candidate.createdAt < ttlMs
    );
  });
}

function writeEntries(storeKey: string, entries: readonly StoredEntry[]): void {
  const store = storage();
  if (!store) return;
  try {
    store.setItem(storeKey, JSON.stringify(entries.slice(-MAX_STORED_ENTRIES)));
  } catch {
    // Quota or a refusing store. The caller already holds the value it wanted
    // remembered; losing the durability is strictly better than losing the
    // deposit.
  }
}

/**
 * What makes two submissions the SAME request: the strategy, the wallet paying
 * for it, and the amount. Change any one and it is a different deposit, not a
 * retry — which is exactly the distinction an idempotency key has to encode.
 */
export function vaultDepositRequestFingerprint(input: {
  strategyId: string;
  custodyWalletId: string;
  amount: string;
}): string {
  return JSON.stringify([input.strategyId, input.custodyWalletId, input.amount]);
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

/** Movement ids still worth polling, newest last, expired entries dropped. */
export function readVaultDepositWatches(): string[] {
  return [...new Set(readEntries(WATCH_STORE_KEY, WATCH_TTL_MS).map((entry) => entry.value))];
}

export function rememberVaultDepositWatch(movementId: string): void {
  const entries = readEntries(WATCH_STORE_KEY, WATCH_TTL_MS);
  if (entries.some((entry) => entry.id === movementId)) return;
  writeEntries(WATCH_STORE_KEY, [
    ...entries,
    { id: movementId, value: movementId, createdAt: Date.now() },
  ]);
}

export function forgetVaultDepositWatch(movementId: string): void {
  const entries = readEntries(WATCH_STORE_KEY, WATCH_TTL_MS);
  if (!entries.some((entry) => entry.id === movementId)) return;
  writeEntries(
    WATCH_STORE_KEY,
    entries.filter((entry) => entry.id !== movementId)
  );
}
