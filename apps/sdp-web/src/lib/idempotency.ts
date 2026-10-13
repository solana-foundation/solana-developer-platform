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

/** What sdp-api answered a keyed request: its status (`null` for no answer) and replay mark. */
export interface ApiAnswer {
  status: number | null;
  replayed: boolean;
}

/**
 * The one rule every dashboard key holder applies (HOO-1918): an answer retires
 * its key, so the next submit of the same input is a new action, when it is a
 * success, a replay (`Idempotent-Replayed`), or a 422 (the key is another
 * request's). Anything else keeps it, a lost answer included, so the retry is
 * the same request: an unstored refusal simply runs again under it, and a
 * failure recorded after the request's row comes back as a replay, which
 * retires it.
 */
export function answerRetiresKey(answer: ApiAnswer): boolean {
  const { status, replayed } = answer;
  return replayed || (status !== null && ((status >= 200 && status < 300) || status === 422));
}

/**
 * The answer a `dashboardFetch`-shaped result carries. A failure below 400 (a
 * followed redirect, a body nobody could read) is no answer from sdp-api, so it
 * reads as a lost one.
 */
export function fetchResultAnswer(result: {
  ok: boolean;
  status: number | null;
  replayed?: boolean;
}): ApiAnswer {
  const answered = result.ok || (result.status !== null && result.status >= 400);
  return { status: answered ? result.status : null, replayed: result.replayed === true };
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
