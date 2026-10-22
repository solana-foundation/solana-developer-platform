import { createClusterRpc } from "@sdp/rpc/factory";
import { currentClusterScope } from "@sdp/rpc/scope";
import type { SdpEnvironment } from "@sdp/types/api-keys";
import type { PaymentRequestRow } from "@/db/repositories/payment-requests.repository";
import { createSystemPaymentRequestsRepository } from "@/db/repositories/repository-factory";
import { describeError, logEvent } from "@/runtime/money-path-events";
import {
  checkAwaitingPaymentRequest,
  checkExpiredPaymentRequestForLatePayment,
  closeLapsedPaymentRequest,
} from "@/services/payments/payment-requests";
import type { Env } from "@/types/env";

const HOT_BATCH_SIZE = 64;
const SWEEP_BATCH_SIZE = 256;
const EXPIRY_BATCH_SIZE = 128;
const LATE_CHECK_BATCH_SIZE = 128;
const CHECK_CONCURRENCY = 8;
const SWEEP_MIN_RECHECK_MS = 45_000;
const SWEEP_AGED_RECHECK_MS = 10 * 60_000;
const SWEEP_AGED_AFTER_MS = 24 * 60 * 60_000;
const EXPIRY_MIN_RECHECK_MS = 45_000;
const EXPIRY_STALE_AFTER_MS = 10 * 60_000;
const HOT_LANE_BLOCK_MARGIN = 150n;
const LATE_PAYMENT_WATCH_MS = 7 * 24 * 60 * 60_000;
const LATE_PAYMENT_RECHECK_MS = 10 * 60_000;
const STALE_AFTER_MS = 2 * SWEEP_AGED_RECHECK_MS;
const LATE_PAYMENT_STALE_AFTER_MS = 2 * LATE_PAYMENT_RECHECK_MS;

type RowCheck = (env: Env, row: PaymentRequestRow) => Promise<PaymentRequestRow>;
type Lane = "hot" | "sweep" | "expiry" | "late_watch";

export async function reconcileHotPaymentRequests(env: Env): Promise<void> {
  const { environment } = currentClusterScope();
  const blockHeight = await createClusterRpc().getBlockHeight({ commitment: "confirmed" }).send();
  const rows = await createSystemPaymentRequestsRepository(env).listHotPaymentRequests({
    environment,
    minLastValidBlockHeight: blockHeight - HOT_LANE_BLOCK_MARGIN,
    limit: HOT_BATCH_SIZE,
  });
  await checkEach(env, environment, rows, checkAwaitingPaymentRequest, "hot");
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
  await checkEach(env, environment, rows, checkAwaitingPaymentRequest, "sweep");
}

export async function expirePaymentRequests(env: Env): Promise<void> {
  const { environment } = currentClusterScope();
  const repo = createSystemPaymentRequestsRepository(env);
  const blockHeight = await createClusterRpc().getBlockHeight({ commitment: "confirmed" }).send();
  const staleLapsed = await repo.countStaleLapsedPaymentRequests({
    environment,
    checkedBefore: new Date(Date.now() - EXPIRY_STALE_AFTER_MS).toISOString(),
  });
  if (staleLapsed > 0) {
    logEvent("warn", { event: "payment_requests.expiry_backlog", environment, stale: staleLapsed });
  }
  const lapsed = await repo.listLapsedPaymentRequests({
    environment,
    checkedBefore: new Date(Date.now() - EXPIRY_MIN_RECHECK_MS).toISOString(),
    liveClaimMinLastValidBlockHeight: blockHeight - HOT_LANE_BLOCK_MARGIN,
    limit: EXPIRY_BATCH_SIZE,
  });
  await checkEach(env, environment, lapsed, closeLapsedPaymentRequest, "expiry");

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
  await checkEach(
    env,
    environment,
    watched,
    checkExpiredPaymentRequestForLatePayment,
    "late_watch"
  );
}

async function checkEach(
  env: Env,
  environment: SdpEnvironment,
  rows: readonly PaymentRequestRow[],
  check: RowCheck,
  lane: Lane
): Promise<void> {
  let failed = 0;
  let settled = 0;
  await forEachConcurrently(rows, CHECK_CONCURRENCY, async (row) => {
    try {
      const after = await check(env, row);
      if (after.status !== row.status) {
        settled += 1;
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
      failed += 1;
      logEvent("error", {
        event: "payment_requests.check_failed",
        lane,
        payment_request_id: row.id,
        ...describeError(error),
      });
    }
  });
  if (rows.length > 0) {
    await createSystemPaymentRequestsRepository(env).markPaymentRequestsChecked(
      rows.map((row) => row.id)
    );
  }
  logEvent(failed > 0 ? "warn" : "info", {
    event: "payment_requests.lane_run",
    environment,
    lane,
    checked: rows.length,
    failed,
    settled,
  });
}

async function forEachConcurrently<T>(
  items: readonly T[],
  concurrency: number,
  run: (item: T) => Promise<void>
): Promise<void> {
  const queue = items.values();
  const worker = async () => {
    for (const item of queue) {
      await run(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
}
