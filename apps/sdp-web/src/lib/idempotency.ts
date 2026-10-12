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

const IDEMPOTENCY_KEY_PATTERN = /^[\x20-\x7e]{1,255}$/;

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
