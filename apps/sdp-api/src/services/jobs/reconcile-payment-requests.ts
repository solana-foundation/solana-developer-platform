/**
 * Background Job: Reconcile Payment Requests
 *
 * Settles open payment requests against the chain so a paid request turns `paid` without anyone
 * opening it. Each row goes through `reconcilePaymentRequest`, the same settlement the list, the
 * request read and `/pay` run, so a swept settlement and a read one cannot diverge.
 *
 * Runs inside one cluster scope per environment (a `cluster` Cron Definition): each run selects
 * only requests whose project is in the scope's environment and reads them through that cluster.
 * Settlement is idempotent (unique transfer signature, status compare-and-set), so overlapping
 * runs or a concurrent read converge on one settlement.
 */

import { currentClusterScope } from "@sdp/rpc/scope";
import { createSystemPaymentRequestsRepository } from "@/db/repositories/repository-factory";
import {
  PAYMENT_REQUEST_SETTLEMENT_GRACE_MS,
  reconcilePaymentRequest,
} from "@/services/payments/payment-requests";
import type { Env } from "@/types/env";

/** How far back the sweep looks; an older request that never expires settles when it is read. */
export const PAYMENT_REQUEST_RECONCILE_HORIZON_MS = 7 * 24 * 60 * 60 * 1000;

/** Requests reconciled per run; each costs one reference lookup on the cluster. */
const RECONCILE_BATCH_SIZE = 100;

/**
 * Reconcile this environment's open payment requests, one at a time, best effort: one row's RPC
 * failure is logged by `reconcilePaymentRequest` and the next run retries it.
 *
 * @param env - API environment for database and RPC access.
 * @returns Resolves once every selected request has been reconciled.
 */
export async function reconcilePaymentRequests(env: Env): Promise<void> {
  const now = Date.now();
  const rows = await createSystemPaymentRequestsRepository(env).listPaymentRequestsToReconcile({
    environment: currentClusterScope().environment,
    createdAfter: new Date(now - PAYMENT_REQUEST_RECONCILE_HORIZON_MS).toISOString(),
    expiredAfter: new Date(now - PAYMENT_REQUEST_SETTLEMENT_GRACE_MS).toISOString(),
    limit: RECONCILE_BATCH_SIZE,
  });
  for (const row of rows) {
    await reconcilePaymentRequest(env, row, { bestEffort: true });
  }
}
