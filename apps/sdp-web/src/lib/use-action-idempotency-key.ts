"use client";

import { z } from "zod";
import type { ActionKeyAnswer } from "./idempotency";
import { createActionMemo } from "./idempotency-key-store";

/** What a server action reports: its status, and on a failure what it settles about the key. */
export interface ActionKeyResult {
  status: string;
  keyAnswer?: ActionKeyAnswer;
}

const actionKeys = createActionMemo("sdp:dashboard:action-idempotency-keys:v1", z.string().min(1));

/** Called right before the action is sent. */
function keyFor(input: string): string {
  return actionKeys.valueFor(input, () => crypto.randomUUID());
}

function settled(input: string, result: ActionKeyResult): void {
  // A thrown action, or a result that does not say, may have written.
  actionKeys.settle(
    input,
    result.status === "success" ? "definitive" : (result.keyAnswer ?? "open")
  );
}

/**
 * One Idempotency-Key per user action for a server action (HOO-1918). The same
 * input keeps its key across retries, double submits, an edit and back (A to
 * B to A) and a reload, until the action is definitively answered; changed
 * input is a new action with a new key, so an edit after a failure never
 * reuses a key for a different request (422). Kept in `sessionStorage` (see
 * `createActionMemo`); when the browser refuses storage the key lives as long as
 * the page, and the action is still sent: these are not money routes.
 *
 * @returns `keyFor(input)` right before the send, and `settled(input, result)`
 *   once it answers. A success or a replay retires the key, and so does a
 *   refusal when no earlier attempt went unanswered ({@link ActionKeyAnswer});
 *   anything else keeps it, so the retry is the same request.
 */
export function useActionIdempotencyKey() {
  return { keyFor, settled };
}
