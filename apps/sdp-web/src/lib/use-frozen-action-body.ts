"use client";

import { useCallback, useRef } from "react";
import { keyAnswerFor } from "./idempotency";

/**
 * Freezes the body a user action sends until the action is definitively
 * answered, for a body computed at submit (an expiry read from the clock).
 * `dashboard-fetch` keys a mutation by its body, so a retry that recomputed it
 * would be a new action under a new key, and could repeat a write the first
 * attempt made. Frozen, the retry resends identical bytes under the same key.
 *
 * @returns `bodyFor(input, build)`, which builds the body once per input, and
 *   `settled(input, result)` once it answers. The body is released on the
 *   rule that retires `dashboard-fetch`'s key ({@link keyAnswerFor}): a
 *   success, or a refusal on the first attempt. Anything else keeps it.
 */
export function useFrozenActionBody<T>() {
  const frozen = useRef<{ input: string; body: T; unanswered: boolean } | null>(null);

  const bodyFor = useCallback((input: string, build: () => T): T => {
    if (frozen.current?.input !== input) {
      frozen.current = { input, body: build(), unanswered: false };
    }
    return frozen.current.body;
  }, []);

  const settled = useCallback(
    (input: string, result: { ok: boolean; status: number | null }): void => {
      const current = frozen.current;
      if (current?.input !== input) return;
      // A failure below 400 is a body nobody could read (a followed redirect),
      // not an answer, so it keeps the body as it keeps the key.
      const answer = result.ok
        ? "definitive"
        : result.status !== null && result.status >= 400
          ? keyAnswerFor(result.status, false)
          : "open";
      if (answer === "definitive" || (answer === "refused" && !current.unanswered)) {
        frozen.current = null;
      } else {
        current.unanswered = true;
      }
    },
    []
  );

  return { bodyFor, settled };
}
