/**
 * A fresh Idempotency-Key for a DvP request, from `getRandomValues` rather than
 * `randomUUID`: the latter needs a secure context, and a dashboard reached over
 * plain http on a LAN address has none.
 *
 * @param prefix - Names the action, so a key read in a log says what it guarded.
 */
export function freshDvpIdempotencyKey(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return `${prefix}-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}
