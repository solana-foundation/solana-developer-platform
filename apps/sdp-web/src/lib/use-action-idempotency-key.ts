"use client";

import { useCallback, useRef } from "react";

/**
 * One Idempotency-Key per user action for a server action (HOO-1918). The same
 * input keeps its key across retries and double submits until the action
 * succeeds; changed input is a new action with a new key, so an edit after a
 * failure never reuses a key for a different request (422).
 *
 * @returns `keyFor(input)` for the submit, and `settled(input, succeeded)` once
 *   it answers: a success retires the key; a failure keeps it, so the retry
 *   is the same request.
 */
export function useActionIdempotencyKey() {
  const current = useRef<{ input: string; key: string } | null>(null);

  const keyFor = useCallback((input: string): string => {
    if (current.current?.input !== input) {
      current.current = { input, key: crypto.randomUUID() };
    }
    return current.current.key;
  }, []);

  const settled = useCallback((input: string, succeeded: boolean): void => {
    if (succeeded && current.current?.input === input) {
      current.current = null;
    }
  }, []);

  return { keyFor, settled };
}
