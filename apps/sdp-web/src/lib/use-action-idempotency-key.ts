"use client";

import { useMemo } from "react";
import { z } from "zod";
import { type ApiAnswer, isOutcomeUnknownAnswer } from "./idempotency";
import { createActionMemo } from "./idempotency-key-store";
import { type OutcomeUnknownLists, useOutcomeUnknownRefresh } from "./use-outcome-unknown";

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

/** @returns What sdp-api answered: the answer settles the key. */
function settle(input: string, key: string, result: ActionKeyResult): ApiAnswer {
  // A success retires the key; a thrown action, or a result that names no
  // answer, may have written, so it keeps it.
  const answer =
    result.status === "success"
      ? { status: 200, replayed: false, code: null }
      : (result.answer ?? { status: null, replayed: false, code: null });
  actionKeys.settle(input, key, answer);
  return answer;
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
 * A 409 `IDEMPOTENCY_KEY_OUTCOME_UNKNOWN` retires the key and refreshes the
 * page and the action's `lists`, so the row the earlier attempt may have made
 * shows up; the action's own
 * message tells the user to check the list before trying again.
 *
 * @returns `keyFor(input)` right before the send, and `settled(input, key, result)`
 *   once it answers.
 */
export function useActionIdempotencyKey(lists: OutcomeUnknownLists) {
  const refresh = useOutcomeUnknownRefresh(lists);
  return useMemo(
    () => ({
      keyFor,
      settled(input: string, key: string, result: ActionKeyResult): void {
        if (isOutcomeUnknownAnswer(settle(input, key, result))) refresh();
      },
    }),
    [refresh]
  );
}
