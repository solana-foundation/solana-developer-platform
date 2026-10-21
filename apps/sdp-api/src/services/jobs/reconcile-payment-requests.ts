/**
 * Background Job: Reconcile Payment Requests
 *
 * Settles open payment requests against the chain so a paid request turns `paid` without anyone
 * opening it. Each row goes through `reconcilePaymentRequest`, the same settlement the list, the
 * request read and `/pay` run, so a swept settlement and a read one cannot diverge.
 *
 * Runs inside one cluster scope per environment (a `cluster` Cron Definition): each run selects
 * only requests whose project is in the scope's environment and reads them through that cluster.
 * Each run takes the least recently checked open requests, a never-checked one queued by its
 * creation time, and stamps every one it tried, so the sweep rotates fairly through all of them. Settlement is idempotent (unique transfer signature,
 * status compare-and-set), so overlapping runs or a concurrent read converge on one settlement.
 */

import { currentClusterScope } from "@sdp/rpc/scope";
import type { PaymentRequestRow } from "@/db/repositories/payment-requests.repository";
import { createSystemPaymentRequestsRepository } from "@/db/repositories/repository-factory";
import { mapSettledWithConcurrency } from "@/lib/concurrency";
import { logEvent, paymentsErrorDiagnostics } from "@/runtime/money-path-events";
import {
  PAYMENT_REQUEST_FINAL_CHECK_AFTER_MS,
  reconcilePaymentRequest,
} from "@/services/payments/payment-requests";
import type { Env } from "@/types/env";

/**
 * Requests reconciled per run. At one run a minute every open request in an environment is
 * reconciled at least hourly while the environment has at most 60 times this many open.
 */
const RECONCILE_BATCH_SIZE = 200;

/** Requests reconciled at once; each holds a few RPC calls on the billed cluster endpoint. */
const RECONCILE_CONCURRENCY = 5;

/**
 * Reconcile this environment's next batch of open payment requests. A row that fails is logged
 * and still stamped, so it moves to the back of the rotation instead of blocking the front.
 *
 * @param env - API environment for database and RPC access.
 * @returns Resolves once every selected request has been tried and stamped.
 */
export async function reconcilePaymentRequests(env: Env): Promise<void> {
  const { environment } = currentClusterScope();
  const repository = createSystemPaymentRequestsRepository(env);
  const rows = await repository.listPaymentRequestsToReconcile({
    environment,
    finalCheckAfterMs: PAYMENT_REQUEST_FINAL_CHECK_AFTER_MS,
    limit: RECONCILE_BATCH_SIZE,
  });
  const outcomes = await mapSettledWithConcurrency(rows, RECONCILE_CONCURRENCY, (row) =>
    reconcilePaymentRequest(env, row, { bestEffort: true })
  );
  await repository.markPaymentRequestsChecked(rows.map((row) => row.id));

  let paid = 0;
  let failed = 0;
  for (const [index, outcome] of outcomes.entries()) {
    if (outcome.status === "fulfilled") {
      if (outcome.value.status === "paid") {
        paid += 1;
      }
      continue;
    }
    failed += 1;
    // SAFETY: mapSettledWithConcurrency returns one outcome per row, aligned by index.
    const row = rows[index] as PaymentRequestRow;
    logEvent("warn", {
      event: "sdp_api_payment_request_reconcile_failed",
      flow: "payment-request-settlement",
      payment_request_id: row.id,
      environment,
      error: outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason),
      error_diagnostics: paymentsErrorDiagnostics(outcome.reason),
    });
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
