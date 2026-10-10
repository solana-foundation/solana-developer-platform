/**
 * Idempotency-Key modes (HOO-1918). `required` refuses a request without a
 * key; `accepted` honors a key when one is sent. Shared so registries in
 * `@sdp/types` can name a route's mode as well as the route itself.
 */
export const IDEMPOTENCY_KEY_MODES = ["required", "accepted"] as const;

export type IdempotencyKeyMode = (typeof IDEMPOTENCY_KEY_MODES)[number];
