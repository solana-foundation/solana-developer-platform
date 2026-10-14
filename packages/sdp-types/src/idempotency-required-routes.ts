/**
 * The API routes that refuse a request without an Idempotency-Key: the ones
 * that move money (HOO-1918, ADR 0009). One list, mapped by the dashboard,
 * which refuses to send on these when it cannot persist the key. The routes PR
 * adds the assertion that the API's route inventory matches it; until then the
 * API does not check it.
 */
export const IDEMPOTENCY_REQUIRED_ROUTES = [
  "POST /v1/payments/transfers",
  "POST /v1/payments/transfer-batches",
  "POST /v1/payments/recurring-payments",
  "POST /v1/payments/recurring-payments/:id/activate",
  "POST /v1/payments/recurring-payments/:id/cancel",
  "POST /v1/payments/recurring-payments/:id/collect",
  "POST /v1/payments/recurring-payments/:id/resume",
] as const;

export type IdempotencyRequiredRoute = (typeof IDEMPOTENCY_REQUIRED_ROUTES)[number];
