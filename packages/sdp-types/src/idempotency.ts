/**
 * Idempotency-Key modes (HOO-1918). `required` refuses a request without a
 * key; `accepted` honors a key when one is sent. Shared so a route's mode can
 * be declared in `@sdp/types` registries (HOO-1955's `MOVEMENTS`) as well as
 * on the route itself.
 */
export const IDEMPOTENCY_KEY_MODES = ["required", "accepted"] as const;

export type IdempotencyKeyMode = (typeof IDEMPOTENCY_KEY_MODES)[number];
