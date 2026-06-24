/**
 * Background Job: Track Pending Payment Requests
 *
 * Runs on the same cron tick as track-pending-transfers. For every open
 * (`awaiting_payment`) request across all orgs it either:
 *
 * 1. Expires the request when it is past `expires_at` — keeps the open set
 *    bounded so the sweep cost stays flat instead of growing with every
 *    abandoned link.
 *
 * 2. Reconciles it against the chain via `reconcilePaymentRequest` — the
 *    reference lookup is one cheap RPC call per unpaid link, so a tick over N
 *    open links is ~N getSignaturesForAddress calls and only does the heavier
 *    transaction validation for links that actually got paid.
 *
 * This is the eventual-consistency backstop. Real-time settlement (the moment a
 * payer's wallet submits) belongs to an indexer webhook subscribed per merchant
 * wallet; this sweep still catches anything the webhook misses or delays.
 */

import type { PaymentRequestRow } from "@/db/repositories/payment-requests.repository";
import { createPaymentRequestsRepository } from "@/db/repositories/repository-factory";
import { reconcilePaymentRequest } from "@/services/payments/reconcile-payment-request";
import type { Env } from "@/types/env";

// Cap the per-tick batch so one sweep can't fan out unboundedly; oldest open
// links are reconciled first, the rest catch up on the next tick.
const MAX_PAYMENT_REQUESTS_PER_TICK = 256;
// Bound concurrent RPC calls per tick to stay under provider rate limits.
const RECONCILE_CONCURRENCY = 10;

export async function trackPendingPaymentRequests(env: Env): Promise<void> {
  const repo = createPaymentRequestsRepository(env);
  const requests = await repo.listAwaitingPaymentRequests(MAX_PAYMENT_REQUESTS_PER_TICK);
  const now = Date.now();

  for (let i = 0; i < requests.length; i += RECONCILE_CONCURRENCY) {
    const chunk = requests.slice(i, i + RECONCILE_CONCURRENCY);
    await Promise.all(chunk.map((request) => reconcileOne(env, request, now)));
  }
}

async function reconcileOne(env: Env, request: PaymentRequestRow, now: number) {
  try {
    if (request.expires_at !== null && Date.parse(request.expires_at) <= now) {
      await createPaymentRequestsRepository(env).settlePaymentRequest(request.id, "expired");
      return;
    }
    await reconcilePaymentRequest(env, request);
  } catch (err) {
    // biome-ignore lint/security/noSecrets: Log message string, not a secret.
    console.error("trackPendingPaymentRequests: failed to reconcile payment request", {
      requestId: request.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
