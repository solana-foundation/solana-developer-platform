"use client";

import type { PaymentTransferBatchRequest } from "@sdp/types";
import { z } from "zod";

/**
 * Browser-side durability for the transfer-batch IDEMPOTENCY KEY.
 *
 * `POST /v1/payments/transfer-batches` replays by Idempotency-Key + payload
 * fingerprint, but only when the caller carries a key at all — an unkeyed
 * retry is a brand-new batch that moves the whole amount again. The dashboard
 * is that caller, so the key has to be minted here and it has to survive the
 * exact windows a retry happens in: a double press, a timeout the customer
 * answers by pressing again, and a tab that reloaded mid-flight. A React ref
 * covers none of those.
 *
 * Same design as `dashboard/markets/earn/earn-vault-deposit-tracking.ts`, for
 * the same reasons; the mechanics that look paranoid are each load-bearing:
 *
 * - `sessionStorage`, not `localStorage`: per-tab working state about a
 *   request in flight, which should die with the tab rather than resurface in
 *   a different context days later.
 * - Every write lands in a module-scope map FIRST. A refused store must cost
 *   durability across a reload, never the answer to "is this the same
 *   request" — minting a fresh key for a request already in flight is the one
 *   failure this module exists to prevent.
 * - A failed write flips the key to memory-preferred (`storageDiverged`):
 *   quota failures are asymmetric (`setItem` throws while `getItem` keeps
 *   serving the stale previous state), and serving readable-but-stale storage
 *   would un-write the just-claimed key.
 * - Entries are zod-parsed per row on read: the store is untrusted JSON
 *   written as often by an older build of this page as by the current one.
 * - HELD entries (a policy approval is pending on the key) never expire and
 *   are never evicted: the approval executor replays the original request
 *   with this exact key, so losing it opens a second approval request for one
 *   intent, while keeping it too long costs at most a replay the API reports
 *   honestly.
 */

const IDEMPOTENCY_STORE_KEY = "sdp:payments:transfer-batch:idempotency:v1";

/**
 * How long a minted key stays claimable for the same request. It must outlast
 * a human retry after a timeout, and expire before the key could be mistaken
 * for a NEW intent — an unkeyed batch settles or fails within a blockhash
 * (~90s) plus the pending-transfers sweep, so fifteen minutes is far past any
 * live ambiguity. Held entries suspend this clock entirely.
 */
const IDEMPOTENCY_TTL_MS = 15 * 60_000;

/** Cap on EXPIRING entries; held entries are exempt (see `withinStorageBound`). */
const MAX_STORED_ENTRIES = 20;

const storedEntrySchema = z.object({
  /** The request fingerprint this key belongs to. */
  id: z.string().min(1),
  value: z.string().min(1),
  createdAt: z.number().finite(),
  /** `null` = held by a live approval: no expiry while the tab lives. */
  expiresAt: z.union([z.number().finite(), z.null()]).optional(),
});

type StoredEntry = z.infer<typeof storedEntrySchema>;

function isHeldEntry(entry: StoredEntry): boolean {
  return entry.expiresAt === null;
}

function isLiveEntry(entry: StoredEntry, now: number): boolean {
  if (entry.expiresAt !== undefined) {
    return entry.expiresAt === null || now < entry.expiresAt;
  }
  return now - entry.createdAt < IDEMPOTENCY_TTL_MS;
}

/**
 * Bound the store by evicting EXPIRING entries only, with a floor of one so
 * the entry a caller just claimed — written as the last element — can never be
 * evicted by its own write. A held entry is never dropped: its count is
 * bounded by real approval requests a person raised in one tab, and losing
 * one mints a fresh key that opens a SECOND approval request for one intent.
 */
function withinStorageBound(entries: readonly StoredEntry[]): StoredEntry[] {
  const held = entries.filter(isHeldEntry);
  const room = Math.max(1, MAX_STORED_ENTRIES - held.length);
  const expiring = entries.filter((entry) => !isHeldEntry(entry));
  const keptExpiring = expiring.slice(-room);
  const kept = new Set<StoredEntry>([...held, ...keptExpiring]);
  return entries.filter((entry) => kept.has(entry));
}

function storage(): Storage | null {
  try {
    if (typeof window === "undefined") return null;
    return window.sessionStorage ?? null;
  } catch {
    return null;
  }
}

/** The tier that cannot fail; authoritative while storage refuses or lags. */
let memoryEntries: readonly StoredEntry[] | undefined;
let storageDiverged = false;

/** @internal Test-only: clear the module-scope tiers so specs are order-independent. */
export function resetTransferBatchIdempotencyStateForTests(): void {
  memoryEntries = undefined;
  storageDiverged = false;
}

function readEntries(): StoredEntry[] {
  let parsed: unknown;
  if (storageDiverged) {
    parsed = memoryEntries ?? [];
  } else {
    const store = storage();
    let raw: string | null | undefined;
    let usable = store !== null;
    if (store) {
      try {
        raw = store.getItem(IDEMPOTENCY_STORE_KEY);
      } catch {
        usable = false;
      }
    }
    if (!usable) {
      parsed = memoryEntries ?? [];
    } else if (raw === null || raw === undefined) {
      return [];
    } else {
      try {
        parsed = JSON.parse(raw);
      } catch {
        return [];
      }
    }
  }
  if (!Array.isArray(parsed)) return [];

  const now = Date.now();
  return parsed.flatMap((entry) => {
    const candidate = storedEntrySchema.safeParse(entry);
    if (!candidate.success) return [];
    return isLiveEntry(candidate.data, now) ? [candidate.data] : [];
  });
}

function writeEntries(entries: readonly StoredEntry[]): void {
  const bounded = withinStorageBound(entries);
  // Memory first and unconditionally: it must already hold the value if the
  // store refuses the very next write.
  memoryEntries = bounded;

  const store = storage();
  if (!store) return;
  try {
    store.setItem(IDEMPOTENCY_STORE_KEY, JSON.stringify(bounded));
    storageDiverged = false;
  } catch {
    // Quota or a refusing store: losing durability beats losing the batch,
    // but a still-readable storage is now BEHIND memory — prefer memory until
    // a write lands, or the next read un-writes the just-claimed key.
    storageDiverged = true;
  }
}

/**
 * What makes two submissions the SAME batch: the source wallet, the token,
 * every recipient with its amount, and the external reference. Change any one
 * and it is a different batch, not a retry. Recipients are sorted by account
 * id so re-selecting the same set in a different order stays the same intent
 * — the API's own fingerprint is over resolved recipients, order-sensitive,
 * but this key only has to be STABLE per intent on this client, and the 409
 * fingerprint conflict is the backstop if the two ever disagree.
 */
export function transferBatchRequestFingerprint(request: PaymentTransferBatchRequest): string {
  return JSON.stringify([
    request.projectId ?? null,
    request.externalId ?? null,
    request.sourceCustodyWalletId,
    request.token,
    [...request.recipients]
      .sort((a, b) => a.counterpartyAccountId.localeCompare(b.counterpartyAccountId))
      .map((recipient) => [
        recipient.counterpartyId,
        recipient.counterpartyAccountId,
        recipient.amount,
      ]),
    request.options ?? null,
  ]);
}

/**
 * The idempotency key for this request, minting and persisting one the first
 * time. Called again for the same fingerprint — a retry, or the same batch
 * rebuilt after a reload — it returns the SAME key, which is what makes the
 * retry a retry instead of a second batch.
 */
export function claimTransferBatchIdempotencyKey(fingerprint: string): string {
  const entries = readEntries();
  const existing = entries.find((entry) => entry.id === fingerprint);
  if (existing) return existing.value;

  const key = crypto.randomUUID();
  writeEntries([
    ...entries.filter((entry) => entry.id !== fingerprint),
    { id: fingerprint, value: key, createdAt: Date.now() },
  ]);
  return key;
}

/**
 * Pin a key while a policy approval holds the batch (202 SIGNING_PENDING).
 *
 * The default TTL is calibrated to a broadcast, but an approval answers to a
 * human and can take hours. The approval executor replays the ORIGINAL
 * request with this exact key, so once it executes, a resubmit with the held
 * key is answered as a replay of the recorded batch — and even a duplicate
 * approval request created by an impatient resubmit collapses into that same
 * replay when its execution carries the same key. Letting the key lapse
 * instead would mint a fresh one, and a fresh key is a second batch.
 */
export function holdTransferBatchIdempotencyKey(fingerprint: string): void {
  const entries = readEntries();
  const held = entries.find((entry) => entry.id === fingerprint);
  if (!held) return;
  writeEntries([
    ...entries.filter((entry) => entry.id !== fingerprint),
    { ...held, expiresAt: null },
  ]);
}

/**
 * Retire a key once the API has ANSWERED for it: a recorded batch (any
 * terminal or processing status — the row exists, replays are safe) or a 4xx
 * refusal. Never on a 5xx or a network failure: a gateway timing out
 * downstream of an API that already recorded the batch looks exactly like the
 * API being down before it did, and a key released too early turns the next
 * retry into a second batch. A key held too long only costs a replay.
 */
export function releaseTransferBatchIdempotencyKey(fingerprint: string): void {
  const entries = readEntries();
  if (!entries.some((entry) => entry.id === fingerprint)) return;
  writeEntries(entries.filter((entry) => entry.id !== fingerprint));
}
