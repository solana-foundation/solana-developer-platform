"use client";

import { z } from "zod";
import { fetchResultAnswer } from "@/lib/idempotency";
import { createActionMemo } from "@/lib/idempotency-key-store";

/**
 * A frozen expiry with the time it was frozen, which is when its create was
 * first sent. An entry an earlier build wrote is the bare expiry.
 */
const frozenExpirySchema = z.union([
  z.object({ expiresAt: z.string().nullable(), frozenAt: z.number() }),
  z.string().nullable(),
]);
type FrozenExpiry = z.infer<typeof frozenExpirySchema>;

const frozenExpiries = createActionMemo("sdp:payments:request-expiry:v1", frozenExpirySchema);

/**
 * How long a create's retry may go out under its first attempt's key: under
 * the API's 24-hour Idempotency-Key record, so a retry the API would no
 * longer recognize, and could run as a second request, is never sent
 * (SOLA9-901).
 */
export const PAYMENT_REQUEST_RETRY_WINDOW_MS = 23 * 60 * 60 * 1_000;

function expiryOf(frozen: FrozenExpiry): string | null {
  return frozen === null || typeof frozen === "string" ? frozen : frozen.expiresAt;
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
 * @returns The instant to send, `null` for no expiry, or `undefined` when the
 *   frozen instant has already passed or the first attempt is older than
 *   {@link PAYMENT_REQUEST_RETRY_WINDOW_MS}. That request is not sent: the
 *   earlier attempt may have created it, so the caller says to check the list.
 *   The expiry is forgotten, so the next press is a new action with a fresh
 *   key and expiry.
 */
export function expiresAtForAction(
  input: string,
  resolve: () => Date | null
): string | null | undefined {
  const frozen = frozenExpiries.valueFor(input, () => ({
    expiresAt: resolve()?.toISOString() ?? null,
    frozenAt: Date.now(),
  }));
  const expiresAt = expiryOf(frozen);
  const outlivedKey =
    frozen !== null &&
    typeof frozen === "object" &&
    Date.now() - frozen.frozenAt >= PAYMENT_REQUEST_RETRY_WINDOW_MS;
  if (outlivedKey || (expiresAt !== null && Date.parse(expiresAt) <= Date.now())) {
    frozenExpiries.settle(input, frozen, { status: 200, replayed: false, code: null });
    return undefined;
  }
  return expiresAt;
}

/**
 * Record the create's answer, forgetting the expiry on the rule that retires its key.
 *
 * @param expiresAt - What `expiresAtForAction` returned for the answered send.
 */
export function settleExpiresAt(
  input: string,
  expiresAt: string | null,
  result: {
    ok: boolean;
    status: number | null;
    replayed?: boolean;
    code?: string | null;
    unreadable?: boolean;
  }
) {
  // The entry this send went out with, or, when it is already gone, one that
  // settling forgets at once on a retiring answer.
  const frozen = frozenExpiries.valueFor(input, () => ({ expiresAt, frozenAt: Date.now() }));
  if (expiryOf(frozen) !== expiresAt) return;
  frozenExpiries.settle(input, frozen, fetchResultAnswer(result));
}
