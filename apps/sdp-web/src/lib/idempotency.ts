/** Canonical HTTP header used for retry-safe value-moving requests. */
export const IDEMPOTENCY_KEY_HEADER = "Idempotency-Key";

/**
 * The `upstreamHeaders` a BFF proxy route passes to forward the request's
 * inbound Idempotency-Key, or `undefined` when it sent none. The key is the
 * ONLY client-owned transport metadata these endpoints accept — everything
 * else upstream is the proxy's own to set — so it is forwarded by name rather
 * than handing the inbound header bag through.
 */
export function forwardedIdempotencyHeaders(request: Request): Record<string, string> | undefined {
  const idempotencyKey = request.headers.get(IDEMPOTENCY_KEY_HEADER);
  return idempotencyKey ? { [IDEMPOTENCY_KEY_HEADER]: idempotencyKey } : undefined;
}

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
