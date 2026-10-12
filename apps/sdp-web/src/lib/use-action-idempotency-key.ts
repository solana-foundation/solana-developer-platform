"use client";

import { useCallback, useRef } from "react";
import type { ActionKeyAnswer } from "./idempotency";

/** Inputs remembered at once; an unanswered one is never the one dropped. */
const MAX_REMEMBERED_INPUTS = 8;

/** What a server action reports: its status, and on a failure what it settles about the key. */
export interface ActionKeyResult {
  status: string;
  keyAnswer?: ActionKeyAnswer;
}

/**
 * One Idempotency-Key per user action for a server action (HOO-1918). The same
 * input keeps its key across retries and double submits until the action is
 * definitively answered; changed input is a new action with a new key, so an
 * edit after a failure never reuses a key for a different request (422). Each
 * input keeps its own key, so going A to B and back to A reuses A's key while
 * A's attempt is unanswered.
 *
 * @returns `keyFor(input)` for the submit, and `settled(input, result)` once
 *   it answers. A success or a replay retires the key, and so does a refusal
 *   on the key's first attempt ({@link ActionKeyAnswer}); anything else keeps
 *   it, so the retry is the same request.
 */
export function useActionIdempotencyKey() {
  const keys = useRef(new Map<string, { key: string; unanswered: boolean }>());

  const keyFor = useCallback((input: string): string => {
    const remembered = keys.current.get(input);
    if (remembered) return remembered.key;
    const key = crypto.randomUUID();
    keys.current.set(input, { key, unanswered: false });
    for (const [stale, entry] of keys.current) {
      if (keys.current.size <= MAX_REMEMBERED_INPUTS) break;
      if (!entry.unanswered && stale !== input) keys.current.delete(stale);
    }
    return key;
  }, []);

  const settled = useCallback((input: string, result: ActionKeyResult): void => {
    const entry = keys.current.get(input);
    if (!entry) return;
    // A thrown action, or a result that does not say, may have written.
    const answer = result.status === "success" ? "definitive" : (result.keyAnswer ?? "open");
    if (answer === "definitive" || (answer === "refused" && !entry.unanswered)) {
      keys.current.delete(input);
    } else {
      entry.unanswered = true;
    }
  }, []);

  return { keyFor, settled };
}
