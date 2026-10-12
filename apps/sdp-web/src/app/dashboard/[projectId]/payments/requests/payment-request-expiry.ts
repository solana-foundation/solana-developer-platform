"use client";

import { z } from "zod";
import { createActionMemo, dashboardFetchKeyAnswer } from "@/lib/action-memo";

const frozenExpiries = createActionMemo("sdp:payments:request-expiry:v1", z.string().nullable());

/**
 * The `expiresAt` a payment-request create sends, read from the clock once per
 * user action and kept until the action is definitively answered.
 * `dashboard-fetch` keys a mutation by its body, so an expiry read again on
 * the retry (after an edit and back, or a reload) would be a new body under a
 * new key, and a first attempt that did create could be repeated.
 *
 * @param input - The form as the user chose it, with the expiry preset (never
 *   the computed instant).
 * @param resolve - Reads the instant from the clock, the first time only.
 */
export function expiresAtForAction(input: string, resolve: () => Date | null): string | null {
  return frozenExpiries.valueFor(input, () => resolve()?.toISOString() ?? null);
}

/** Record the create's answer, forgetting the expiry on the rule that retires its key. */
export function settleExpiresAt(input: string, result: { ok: boolean; status: number | null }) {
  frozenExpiries.settle(input, dashboardFetchKeyAnswer(result));
}
