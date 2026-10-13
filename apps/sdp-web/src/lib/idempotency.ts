/** Canonical HTTP header used for retry-safe value-moving requests. */
export const IDEMPOTENCY_KEY_HEADER = "Idempotency-Key";

/** The key sdp-api accepts: 1-255 printable ASCII characters (`idempotency-key.ts` in sdp-api). */
export const IDEMPOTENCY_KEY_PATTERN = /^[\x20-\x7e]{1,255}$/;

/**
 * The headers a server action sends upstream for the Idempotency-Key the
 * browser minted for this user action (HOO-1918), or `undefined` for none or
 * a malformed one. The server never mints a key: a retried action reuses the
 * browser's, and a server-side key would be new on every retry.
 */
export function actionIdempotencyHeaders(key: unknown): Record<string, string> | undefined {
  return typeof key === "string" && IDEMPOTENCY_KEY_PATTERN.test(key)
    ? { [IDEMPOTENCY_KEY_HEADER]: key }
    : undefined;
}

/**
 * What an sdp-api answer settles about the write its key carried:
 *
 * - `definitive`: a success, or a replay. sdp-api ran or stored the request.
 * - `refused`: a 4xx other than a conflict or a rate limit. It retires a key
 *   on its first attempt only; once an earlier attempt went unanswered, a
 *   refusal settles nothing about that attempt, which may have written.
 * - `open`: a 5xx, a 409, a 429, or no answer. The write may have run, so the
 *   key stays for the retry.
 */
export type ActionKeyAnswer = "definitive" | "refused" | "open";

/**
 * The one rule behind {@link ActionKeyAnswer}, shared by `dashboard-fetch` and
 * the server actions that forward the browser's key.
 *
 * @param status - The HTTP status, or `null` when nothing answered.
 * @param replayed - Whether sdp-api marked the answer `Idempotent-Replayed`.
 */
export function keyAnswerFor(status: number | null, replayed: boolean): ActionKeyAnswer {
  if (replayed) return "definitive";
  if (status === null) return "open";
  if (status < 400) return "definitive";
  return status < 500 && status !== 409 && status !== 429 ? "refused" : "open";
}

/**
 * Whether an answer retires its key, so the next submit is a new action: a
 * definitive answer always does, a refusal only when no earlier attempt under
 * the key went unanswered. Every dashboard key holder applies this one rule.
 *
 * @param answer - What the answer settles ({@link keyAnswerFor}).
 * @param earlierAttemptUnanswered - Whether an earlier attempt under this key
 *   never got a definitive answer, so it may have written.
 */
export function answerRetiresKey(
  answer: ActionKeyAnswer,
  earlierAttemptUnanswered: boolean
): boolean {
  return answer === "definitive" || (answer === "refused" && !earlierAttemptUnanswered);
}

/**
 * A 64-bit FNV-1a digest of an action, so request bodies (counterparty
 * details, addresses) never sit in browser storage. Synchronous on purpose:
 * an async digest would delay the send behind later requests and reorder
 * them. Not a security boundary; collisions only within one tab's few
 * pending actions matter, and 64 bits makes those negligible.
 */
export function storageFingerprint(material: string): string {
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(material)) {
    hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, "0");
}
