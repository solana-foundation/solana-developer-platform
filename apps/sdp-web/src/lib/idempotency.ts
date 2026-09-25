/** Canonical HTTP header used for retry-safe value-moving requests. */
export const IDEMPOTENCY_KEY_HEADER = "Idempotency-Key";

/**
 * A fresh Idempotency-Key, from `getRandomValues` rather than `randomUUID`:
 * the latter needs a secure context, and a dashboard reached over plain http
 * on a LAN address has none.
 *
 * @param prefix - Names the action, so a key read in a log says what it guarded.
 */
export function freshIdempotencyKey(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return `${prefix}-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

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
