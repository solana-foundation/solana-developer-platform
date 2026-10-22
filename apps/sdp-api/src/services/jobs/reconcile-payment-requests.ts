import { createClusterRpc } from "@sdp/rpc/factory";
import { currentClusterScope } from "@sdp/rpc/scope";
import type { PaymentRequestRow } from "@/db/repositories/payment-requests.repository";
import { createSystemPaymentRequestsRepository } from "@/db/repositories/repository-factory";
import { describeError, logEvent } from "@/runtime/money-path-events";
import {
  checkAwaitingPaymentRequest,
  checkExpiredPaymentRequestForLatePayment,
  closeLapsedPaymentRequest,
} from "@/services/payments/payment-requests";
import type { Env } from "@/types/env";

const HOT_BATCH_SIZE = 32;
const SWEEP_BATCH_SIZE = 64;
const EXPIRY_BATCH_SIZE = 64;
const LATE_CHECK_BATCH_SIZE = 32;
const SWEEP_MIN_RECHECK_MS = 45_000;
const SWEEP_AGED_RECHECK_MS = 10 * 60_000;
const SWEEP_AGED_AFTER_MS = 24 * 60 * 60_000;
const EXPIRY_MIN_RECHECK_MS = 45_000;
const HOT_LANE_BLOCK_MARGIN = 150n;
const LATE_PAYMENT_WATCH_MS = 7 * 24 * 60 * 60_000;
const LATE_PAYMENT_RECHECK_MS = 10 * 60_000;
const STALE_AFTER_MS = 2 * SWEEP_AGED_RECHECK_MS;
const LATE_PAYMENT_STALE_AFTER_MS = 2 * LATE_PAYMENT_RECHECK_MS;

type RowCheck = (env: Env, row: PaymentRequestRow) => Promise<PaymentRequestRow>;

export async function reconcileHotPaymentRequests(env: Env): Promise<void> {
  const { environment } = currentClusterScope();
  const blockHeight = await createClusterRpc().getBlockHeight({ commitment: "confirmed" }).send();
  const rows = await createSystemPaymentRequestsRepository(env).listHotPaymentRequests({
    environment,
    minLastValidBlockHeight: blockHeight - HOT_LANE_BLOCK_MARGIN,
    limit: HOT_BATCH_SIZE,
  });
  await checkEach(env, rows, checkAwaitingPaymentRequest, "hot");
}

export async function reconcilePaymentRequests(env: Env): Promise<void> {
  const { environment } = currentClusterScope();
  const repo = createSystemPaymentRequestsRepository(env);
  const now = Date.now();
  const stale = await repo.countStaleAwaitingPaymentRequests({
    environment,
    checkedBefore: new Date(now - STALE_AFTER_MS).toISOString(),
  });
  if (stale > 0) {
    logEvent("warn", { event: "payment_requests.reconcile_backlog", environment, stale });
  }

  const rows = await repo.listPaymentRequestsDueForCheck({
    environment,
    recentCheckedBefore: new Date(now - SWEEP_MIN_RECHECK_MS).toISOString(),
    agedCheckedBefore: new Date(now - SWEEP_AGED_RECHECK_MS).toISOString(),
    agedCreatedBefore: new Date(now - SWEEP_AGED_AFTER_MS).toISOString(),
    limit: SWEEP_BATCH_SIZE,
  });
  await checkEach(env, rows, checkAwaitingPaymentRequest, "sweep");
}

export async function expirePaymentRequests(env: Env): Promise<void> {
  const { environment } = currentClusterScope();
  const repo = createSystemPaymentRequestsRepository(env);
  const blockHeight = await createClusterRpc().getBlockHeight({ commitment: "confirmed" }).send();
  const lapsed = await repo.listLapsedPaymentRequests({
    environment,
    checkedBefore: new Date(Date.now() - EXPIRY_MIN_RECHECK_MS).toISOString(),
    liveClaimMinLastValidBlockHeight: blockHeight - HOT_LANE_BLOCK_MARGIN,
    limit: EXPIRY_BATCH_SIZE,
  });
  await checkEach(env, lapsed, closeLapsedPaymentRequest, "expiry");

  const now = Date.now();
  const expiredSince = new Date(now - LATE_PAYMENT_WATCH_MS).toISOString();
  const stale = await repo.countStaleLateWatchPaymentRequests({
    environment,
    expiredSince,
    checkedBefore: new Date(now - LATE_PAYMENT_STALE_AFTER_MS).toISOString(),
  });
  if (stale > 0) {
    logEvent("warn", { event: "payment_requests.late_watch_backlog", environment, stale });
  }

  const watched = await repo.listExpiredPaymentRequestsForLateCheck({
    environment,
    expiredSince,
    checkedBefore: new Date(now - LATE_PAYMENT_RECHECK_MS).toISOString(),
    limit: LATE_CHECK_BATCH_SIZE,
  });
  await checkEach(env, watched, checkExpiredPaymentRequestForLatePayment, "late_watch");
}

async function checkEach(
  env: Env,
  rows: readonly PaymentRequestRow[],
  check: RowCheck,
  lane: string
): Promise<void> {
  if (rows.length === 0) {
    return;
  }
  for (const row of rows) {
    try {
      const after = await check(env, row);
      if (after.status !== row.status) {
        logEvent("info", {
          event: "payment_requests.settled",
          lane,
          payment_request_id: row.id,
          from: row.status,
          to: after.status,
          paid_late: after.paid_late,
        });
      }
    } catch (error) {
      logEvent("error", {
        event: "payment_requests.check_failed",
        lane,
        payment_request_id: row.id,
        ...describeError(error),
      });
    }
  }
  await createSystemPaymentRequestsRepository(env).markPaymentRequestsChecked(
    rows.map((row) => row.id)
  );
}
