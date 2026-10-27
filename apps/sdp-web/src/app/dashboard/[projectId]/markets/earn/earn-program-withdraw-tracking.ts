"use client";

import { createIdempotencyKeyStore } from "@/lib/idempotency-key-store";

/**
 * Durable per-tab keys for PROGRAM withdrawals (the portfolio exit flow), the
 * vault stores' sibling under the same rules
 * (`@/lib/idempotency-key-store.ts`). The request id identifies ONE intended
 * withdrawal to the provider, so a retry — including one entered after an
 * ambiguous failure and a full reload, which loses every React ref — must
 * carry the same id or the provider can pay out twice.
 */
export const programWithdrawalRequestIdStore = createIdempotencyKeyStore(
  "sdp:earn:program-withdrawal:request-id:v1"
);
