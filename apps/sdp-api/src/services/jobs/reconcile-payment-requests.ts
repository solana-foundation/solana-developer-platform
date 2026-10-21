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
import { logEvent, paymentsErrorDiagnostics } from "@/runtime/money-path-events";
import {
  PAYMENT_REQUEST_SETTLEMENT_GRACE_MS,
  reconcilePaymentRequest,
} from "@/services/payments/payment-requests";
import type { Env } from "@/types/env";

/** How far back the sweep looks; an older request that never expires settles when it is read. */
export const PAYMENT_REQUEST_RECONCILE_HORIZON_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Requests reconciled per run, newest first; each costs one reference lookup on the cluster.
 * ponytail: past this many open requests in one environment the oldest wait for a read to
 * settle; a last-checked column with oldest-checked-first ordering lifts that.
 */
const RECONCILE_BATCH_SIZE = 100;

/**
 * Reconcile this environment's open payment requests, one at a time. A row that fails is logged
 * and left for the next run, so one bad row never stalls the rows behind it.
 *
 * @param env - API environment for database and RPC access.
 * @returns Resolves once every selected request has been tried.
 */
export async function reconcilePaymentRequests(env: Env): Promise<void> {
  const { environment } = currentClusterScope();
  const now = Date.now();
  const rows = await createSystemPaymentRequestsRepository(env).listPaymentRequestsToReconcile({
    environment,
    createdAfter: new Date(now - PAYMENT_REQUEST_RECONCILE_HORIZON_MS).toISOString(),
    expiredAfter: new Date(now - PAYMENT_REQUEST_SETTLEMENT_GRACE_MS).toISOString(),
    limit: RECONCILE_BATCH_SIZE,
  });
  let paid = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      const reconciled = await reconcilePaymentRequest(env, row, { bestEffort: true });
      if (reconciled.status === "paid") {
        paid += 1;
      }
    } catch (error) {
      failed += 1;
      logEvent("warn", {
        event: "sdp_api_payment_request_reconcile_failed",
        flow: "payment-request-settlement",
        payment_request_id: row.id,
        environment,
        error: error instanceof Error ? error.message : String(error),
        error_diagnostics: paymentsErrorDiagnostics(error),
      });
    }
  }
  logEvent("info", {
    event: "sdp_api_payment_request_reconcile",
    flow: "payment-request-settlement",
    environment,
    selected: rows.length,
    paid,
    failed,
  });
}
