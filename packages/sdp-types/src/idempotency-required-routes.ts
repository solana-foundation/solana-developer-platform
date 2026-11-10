/**
 * The API routes that refuse a request without an Idempotency-Key: the ones
 * that move money (HOO-1918, ADR 0009). One list, asserted by the API's route
 * inventory and mapped by the dashboard, which refuses to send on these when it
 * cannot persist the key.
 *
 * Each one also answers a retried key from its own domain row
 * (`recovery: "record"`), after the 24-hour key record too, so a kept key is
 * always safe to resend on them: the dashboard resends one however old, since
 * a new key could move the money twice. The route inventory pins this.
 */
export const IDEMPOTENCY_REQUIRED_ROUTES = [
  "POST /v1/payments/transfers",
  "POST /v1/payments/transfer-batches",
  "POST /v1/payments/transfer-batches/:batchId/retry",
  "POST /v1/payments/recurring-payments",
  "PATCH /v1/payments/recurring-payments/:id",
  "POST /v1/payments/recurring-payments/:id/activate",
  "POST /v1/payments/recurring-payments/:id/cancel",
  "POST /v1/payments/recurring-payments/:id/collect",
  "POST /v1/payments/recurring-payments/:id/resume",
] as const;

export type IdempotencyRequiredRoute = (typeof IDEMPOTENCY_REQUIRED_ROUTES)[number];

/** Dashboard-only key generation; deliberately absent from public API surfaces. */
export const INTERNAL_IDEMPOTENCY_REQUIRED_ROUTES = [
  "POST /internal/dashboard/custody/fireblocks/csr",
] as const;
