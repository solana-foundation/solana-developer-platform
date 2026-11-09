"use client";

import { z } from "zod";
import { fetchResultAnswer } from "@/lib/idempotency";
import { createActionMemo } from "@/lib/idempotency-key-store";

/**
 * What the memo stores: a frozen expiry with the time it was frozen, which is
 * when its create was first sent. An entry an earlier build wrote is the bare
 * expiry; it is read at this storage boundary only, and kept as written so it
 * still settles (a memo value must serialize back to what was stored).
 */
const storedExpirySchema = z.union([
  z.object({
    kind: z.literal("frozen"),
    expiresAt: z.string().nullable(),
    frozenAt: z.number(),
  }),
  z.string().nullable(),
]);
type StoredExpiry = z.infer<typeof storedExpirySchema>;

const frozenExpiries = createActionMemo("sdp:payments:request-expiry:v1", storedExpirySchema);

/**
 * How long a create's retry may go out under its first attempt's key: under
 * the API's 24-hour Idempotency-Key record, so a retry the API would no
 * longer recognize, and could run as a second request, is never sent
 * (SOLA9-901).
 */
export const PAYMENT_REQUEST_RETRY_WINDOW_MS = 23 * 60 * 60 * 1_000;

/** A create's frozen expiry, as the action logic reads it. */
type FrozenExpiry =
  | { kind: "frozen"; expiresAt: string | null; frozenAt: number }
  | { kind: "legacy"; expiresAt: string | null };

function frozenExpiryOf(stored: StoredExpiry): FrozenExpiry {
  return stored === null || typeof stored === "string"
    ? { kind: "legacy", expiresAt: stored }
    : stored;
}

/**
 * One send's expiry: the instant it carries and the memo entry it was read
 * from, which {@link settleExpiresAt} settles directly, so an answer that
 * arrives after the dashboard switched organization still settles this entry.
 */
export interface SentExpiry {
  readonly expiresAt: string | null;
  readonly entry: StoredExpiry;
}

/**
 * The `expiresAt` a payment-request create sends, read from the clock once per
 * user action and kept until an answer retires its key (`answerRetiresKey`).
 * `dashboard-fetch` keys a mutation by its body, so an expiry read again on
 * the retry (after an edit and back, or a reload) would be a new body under a
 * new key, and a first attempt that did create could be repeated.
 *
 * @param input - The form as the user chose it, with the expiry preset (never
 *   the computed instant).
 * @param resolve - Reads the instant from the clock, the first time only.
 * @returns The send's expiry, or `undefined` when the frozen instant has
 *   already passed or the first attempt is older than
 *   {@link PAYMENT_REQUEST_RETRY_WINDOW_MS}. That request is not sent: the
 *   earlier attempt may have created it, so the caller says to check the list.
 *   The expiry is forgotten, so the next press is a new action with a fresh
 *   key and expiry.
 */
export function expiresAtForAction(
  input: string,
  resolve: () => Date | null
): SentExpiry | undefined {
  const entry = frozenExpiries.valueFor(input, () => ({
    kind: "frozen" as const,
    expiresAt: resolve()?.toISOString() ?? null,
    frozenAt: Date.now(),
  }));
  const frozen = frozenExpiryOf(entry);
  const outlivedKey =
    frozen.kind === "frozen" && Date.now() - frozen.frozenAt >= PAYMENT_REQUEST_RETRY_WINDOW_MS;
  const expired = frozen.expiresAt !== null && Date.parse(frozen.expiresAt) <= Date.now();
  if (outlivedKey || expired) {
    frozenExpiries.settle(input, entry, { status: 200, replayed: false, code: null });
    return undefined;
  }
  return { expiresAt: frozen.expiresAt, entry };
}

/**
 * Record the create's answer, forgetting the expiry on the rule that retires its key.
 *
 * @param sent - What `expiresAtForAction` returned for the answered send.
 */
export function settleExpiresAt(
  input: string,
  sent: SentExpiry,
  result: {
    ok: boolean;
    status: number | null;
    replayed?: boolean;
    code?: string | null;
    unreadable?: boolean;
  }
) {
  frozenExpiries.settle(input, sent.entry, fetchResultAnswer(result));
}
