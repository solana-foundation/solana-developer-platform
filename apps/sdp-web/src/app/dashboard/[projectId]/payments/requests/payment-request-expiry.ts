"use client";

import { z } from "zod";
import { fetchResultAnswer } from "@/lib/idempotency";
import { createActionMemo } from "@/lib/idempotency-key-store";

const frozenExpiries = createActionMemo("sdp:payments:request-expiry:v1", z.string().nullable());

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
 *   frozen instant has already passed. That request is not sent: the earlier
 *   attempt may have created it, so the caller says to check the list. The
 *   expiry is forgotten, so the next press is a new action with a fresh key
 *   and expiry.
 */
export function expiresAtForAction(
  input: string,
  resolve: () => Date | null
): string | null | undefined {
  const expiresAt = frozenExpiries.valueFor(input, () => resolve()?.toISOString() ?? null);
  if (expiresAt !== null && Date.parse(expiresAt) <= Date.now()) {
    frozenExpiries.settle(input, expiresAt, { status: 200, replayed: false, code: null });
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
  frozenExpiries.settle(input, expiresAt, fetchResultAnswer(result));
}
