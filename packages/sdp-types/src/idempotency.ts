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
