import { isIdempotencyKeyOutcomeUnknown } from "@sdp/types";
import { z } from "zod";

/** Canonical HTTP header used for retry-safe value-moving requests. */
export const IDEMPOTENCY_KEY_HEADER = "Idempotency-Key";

/** The key sdp-api accepts: 1-255 printable ASCII characters (`idempotency-key.ts` in sdp-api). */
export const IDEMPOTENCY_KEY_PATTERN = /^[\x20-\x7e]{1,255}$/;

/** A browser-minted key as a server action receives it, parsed at that boundary. */
const actionIdempotencyKeySchema = z.string().regex(IDEMPOTENCY_KEY_PATTERN);

/**
 * The headers a server action sends upstream for the Idempotency-Key the
 * browser minted for this user action (HOO-1918), or `undefined` for none or
 * a malformed one. The server never mints a key: a retried action reuses the
 * browser's, and a server-side key would be new on every retry.
 *
 * @param key - The browser's value: a form field or an action argument.
 */
export function actionIdempotencyHeaders(
  key: FormDataEntryValue | null | undefined
): Record<string, string> | undefined {
  const parsed = actionIdempotencyKeySchema.safeParse(key);
  if (!parsed.success) return undefined;
  return { [IDEMPOTENCY_KEY_HEADER]: parsed.data };
}

/**
 * What sdp-api answered a keyed request: its status (`null` for no answer),
 * replay mark, and error code (`null` for none, or for a body that names none).
 */
export interface ApiAnswer {
  status: number | null;
  replayed: boolean;
  code: string | null;
}

/** sdp-api's error envelope, as far as the code goes. */
const apiErrorCodeSchema = z.object({ error: z.object({ code: z.string() }) });

/**
 * The error code an sdp-api error body names, or `null` for a body that names
 * none (a success, a proxy's own refusal, text that is not JSON).
 *
 * @param text - The response body as received.
 */
export function apiErrorCode(text: string): string | null {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = apiErrorCodeSchema.safeParse(json);
  return parsed.success ? parsed.data.error.code : null;
}

/**
 * The one rule every dashboard key holder applies (HOO-1918): an answer retires
 * its key, so the next submit of the same input is a new action, when it is a
 * success, a replay (`Idempotent-Replayed`), a 422 (the key is another
 * request's), or a 409 `IDEMPOTENCY_KEY_OUTCOME_UNKNOWN` (the original never
 * recorded its outcome, so every retry under the key gets that same answer; the
 * user checks the list and sends again under a new key). Anything else keeps
 * it, a lost answer included, so the retry is the same request: an unstored
 * refusal (a 409 `IDEMPOTENCY_KEY_IN_FLIGHT` among them) simply runs again
 * under it, and a failure recorded after the request's row comes back as a
 * replay, which retires it.
 */
export function answerRetiresKey(answer: ApiAnswer): boolean {
  const { status, replayed, code } = answer;
  if (replayed) return true;
  if (status === null) return false;
  return (
    (status >= 200 && status < 300) ||
    status === 422 ||
    isIdempotencyKeyOutcomeUnknown(status, code)
  );
}

/**
 * Whether the answer is a 409 `IDEMPOTENCY_KEY_OUTCOME_UNKNOWN`: the original
 * request never recorded its outcome, so it may have run. Its key retires
 * ({@link answerRetiresKey}), but the form must not offer a plain retry: the
 * user is told to check the list first, and the list is refreshed.
 */
export function isOutcomeUnknownAnswer(answer: ApiAnswer): boolean {
  return answer.status !== null && isIdempotencyKeyOutcomeUnknown(answer.status, answer.code);
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
  code?: string | null;
}): ApiAnswer {
  const answered = result.ok || (result.status !== null && result.status >= 400);
  return {
    status: answered ? result.status : null,
    replayed: result.replayed === true,
    code: answered && !result.ok && result.code !== undefined ? result.code : null,
  };
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
