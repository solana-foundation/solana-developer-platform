/**
 * Idempotency-Key modes (HOO-1918). `required` refuses a request without a
 * key; `accepted` honors a key when one is sent. Shared so registries in
 * `@sdp/types` can name a route's mode as well as the route itself.
 */
export const IDEMPOTENCY_KEY_MODES = ["required", "accepted"] as const;

export type IdempotencyKeyMode = (typeof IDEMPOTENCY_KEY_MODES)[number];

/**
 * HTTP statuses an Idempotency-Key never stores: the request was refused
 * before it changed anything, so a retry with the same key runs again. Stripe
 * saves no result for validation failures or concurrent conflicts; refusals
 * of the caller (401, 403, 429) are re-evaluated on every attempt too.
 */
export const IDEMPOTENCY_UNSTORED_STATUSES = [400, 401, 403, 409, 429] as const;

export type IdempotencyUnstoredStatus = (typeof IDEMPOTENCY_UNSTORED_STATUSES)[number];

export function isIdempotencyUnstoredStatus(status: number): status is IdempotencyUnstoredStatus {
  return IDEMPOTENCY_UNSTORED_STATUSES.some((unstored) => unstored === status);
}

/** HTTP statuses whose responses carry no body, so a replay sends none. */
export const BODYLESS_HTTP_STATUSES = [204, 205, 304] as const;

export type BodylessHttpStatus = (typeof BODYLESS_HTTP_STATUSES)[number];

export function isBodylessHttpStatus(status: number): status is BodylessHttpStatus {
  return BODYLESS_HTTP_STATUSES.some((bodyless) => bodyless === status);
}

/**
 * The error codes sdp-api answers an Idempotency-Key refusal with (HOO-1918),
 * so clients read them from one list.
 */
export const IDEMPOTENCY_ERROR_CODES = [
  "IDEMPOTENCY_KEY_REQUIRED",
  "IDEMPOTENCY_KEY_REUSED",
  "IDEMPOTENCY_KEY_IN_FLIGHT",
  "IDEMPOTENCY_KEY_OUTCOME_UNKNOWN",
] as const;

export type IdempotencyErrorCode = (typeof IDEMPOTENCY_ERROR_CODES)[number];

/** Whether an error code is the Idempotency-Key's own refusal, not the route's. */
export function isIdempotencyErrorCode(code: string | null): code is IdempotencyErrorCode {
  return IDEMPOTENCY_ERROR_CODES.some((known) => known === code);
}

/**
 * Whether a refusal ends its key: a 409 `IDEMPOTENCY_KEY_OUTCOME_UNKNOWN`
 * means the original request never recorded its outcome, and every retry under
 * that key would get the same answer. The client checks with GET, then sends
 * under a new key. It carries no Retry-After.
 */
export function isIdempotencyKeyOutcomeUnknown(status: number, code: string | null): boolean {
  return status === 409 && code === "IDEMPOTENCY_KEY_OUTCOME_UNKNOWN";
}

function isAsciiDigit(character: string | undefined): boolean {
  return character !== undefined && character >= "0" && character <= "9";
}

/**
 * A decimal string's canonical spelling, without rounding or passing through a
 * float: no leading integer zeroes, no trailing fraction zeroes, no bare point.
 * `"1.0"`, `"01"` and `"1"` are one amount. The API's Idempotency-Key
 * fingerprints and the dashboard's browser keys both spell amounts with it, so
 * one intent gets one key on either side.
 */
export function normalizeDecimalString(value: string): string {
  const [integer = "0", fraction = ""] = value.split(".");
  // Index scans, not regular expressions: linear in the input whatever it holds.
  let start = 0;
  // A leading zero goes only while a digit follows it, so "0" and "0x" keep theirs.
  while (integer[start] === "0" && isAsciiDigit(integer[start + 1])) start += 1;
  let end = fraction.length;
  while (end > 0 && fraction[end - 1] === "0") end -= 1;
  const normalizedInteger = integer.slice(start) || "0";
  const normalizedFraction = fraction.slice(0, end);
  return normalizedFraction === ""
    ? normalizedInteger
    : `${normalizedInteger}.${normalizedFraction}`;
}

/** A JSON value as `JSON.parse` returns it. */
export type CanonicalJsonValue =
  | string
  | number
  | boolean
  | null
  | CanonicalJsonValue[]
  | { [key: string]: CanonicalJsonValue };

/**
 * Serializes a JSON value with object keys sorted by UTF-16 code unit and array
 * order kept (RFC 8785's ordering; numbers use ECMAScript's canonical form), so
 * equal values always produce equal text whatever the runtime's locale. The
 * API's Idempotency-Key fingerprints and the dashboard's browser keys both use
 * it, so a body that only reorders keys is one request on either side.
 */
export function canonicalJson(value: CanonicalJsonValue): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const members = Object.keys(value)
    // With no comparator, sort orders strings by UTF-16 code unit: RFC 8785's order.
    .sort()
    // SAFETY: every key comes from Object.keys(value), so the member is present.
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key] as CanonicalJsonValue)}`);
  return `{${members.join(",")}}`;
}
