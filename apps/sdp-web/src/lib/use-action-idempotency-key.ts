"use client";

import { z } from "zod";
import type { ApiAnswer } from "./idempotency";
import { createActionMemo } from "./idempotency-key-store";

/** What a server action reports: its status, and on a failure what sdp-api answered. */
export interface ActionKeyResult {
  status: string;
  answer?: ApiAnswer;
}

const actionKeys = createActionMemo("sdp:dashboard:action-idempotency-keys:v1", z.string().min(1));

/** Called right before the action is sent. */
function keyFor(input: string): string {
  return actionKeys.valueFor(input, () => crypto.randomUUID());
}

function settled(input: string, key: string, result: ActionKeyResult): void {
  // A success retires the key; a thrown action, or a result that names no
  // answer, may have written, so it keeps it.
  actionKeys.settle(
    input,
    key,
    result.status === "success"
      ? { status: 200, replayed: false }
      : (result.answer ?? { status: null, replayed: false })
  );
}

/**
 * One Idempotency-Key per user action for a server action (HOO-1918). The same
 * input keeps its key across retries, double submits, an edit and back (A to
 * B to A) and a reload, until an answer retires it (`answerRetiresKey`);
 * changed input is a new action with a new key, so an edit after a failure
 * never reuses a key for a different request (422). Kept in `sessionStorage`
 * (see `createActionMemo`); when the browser refuses storage the key lives as
 * long as the page, and the action is still sent: these are not money routes.
 *
 * @returns `keyFor(input)` right before the send, and `settled(input, key, result)`
 *   once it answers.
 */
export function useActionIdempotencyKey() {
  return { keyFor, settled };
}
