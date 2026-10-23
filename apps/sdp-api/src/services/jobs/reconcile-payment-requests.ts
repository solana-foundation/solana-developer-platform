import { createClusterRpc } from "@sdp/rpc/factory";
import { currentClusterScope } from "@sdp/rpc/scope";
import type {
  PaymentRequestCheckStamp,
  PaymentRequestRow,
} from "@/db/repositories/payment-requests.repository";
import { createSystemPaymentRequestsRepository } from "@/db/repositories/repository-factory";
import { mapSettledWithConcurrency } from "@/lib/concurrency";
import { describeError, logEvent } from "@/runtime/money-path-events";
import {
  checkAwaitingPaymentRequest,
  checkExpiredPaymentRequestForLatePayment,
  closeLapsedPaymentRequest,
  type PaymentRequestCheck,
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

type RowCheck = (env: Env, row: PaymentRequestRow) => Promise<PaymentRequestCheck>;
type Lane = "hot" | "sweep" | "expiry" | "late_watch";

interface LaneRun {
  lane: Lane;
  checked: number;
  failed: number;
}

export async function reconcileHotPaymentRequests(env: Env): Promise<void> {
  const { environment } = currentClusterScope();
  const blockHeight = await createClusterRpc().getBlockHeight({ commitment: "confirmed" }).send();
  const rows = await createSystemPaymentRequestsRepository(env).listHotPaymentRequests({
    environment,
    minLastValidBlockHeight: blockHeight - HOT_LANE_BLOCK_MARGIN,
    limit: HOT_BATCH_SIZE,
  });
  throwIfEveryCheckFailed(await checkEach(env, rows, checkAwaitingPaymentRequest, "hot"));
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
  throwIfEveryCheckFailed(await checkEach(env, rows, checkAwaitingPaymentRequest, "sweep"));
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
  const expiry = await checkEach(env, lapsed, closeLapsedPaymentRequest, "expiry");

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
  const lateWatch = await checkEach(
    env,
    watched,
    checkExpiredPaymentRequestForLatePayment,
    "late_watch"
  );
  throwIfEveryCheckFailed(expiry, lateWatch);
}

function throwIfEveryCheckFailed(...runs: readonly LaneRun[]): void {
  const failedLanes = runs.filter((run) => run.checked > 0 && run.failed === run.checked);
  if (failedLanes.length > 0) {
    throw new Error(
      failedLanes
        .map((run) => `payment request ${run.lane} lane: all ${run.checked} checks failed`)
        .join("; ")
    );
  }
}

async function checkEach(
  env: Env,
  rows: readonly PaymentRequestRow[],
  check: RowCheck,
  lane: Lane
): Promise<LaneRun> {
  const results = await mapSettledWithConcurrency([...rows], CHECK_CONCURRENCY, (row) =>
    check(env, row)
  );
  let failed = 0;
  let settled = 0;
  let blocked = 0;
  const stamps: PaymentRequestCheckStamp[] = [];
  for (const [index, row] of rows.entries()) {
    const result = results[index];
    if (result?.status === "fulfilled") {
      const { row: after, outcome } = result.value;
      stamps.push({ id: row.id, outcome });
      if (outcome.kind === "blocked") {
        blocked += 1;
      }
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
      continue;
    }
    stamps.push({ id: row.id, outcome: { kind: "failed" } });
    failed += 1;
    logEvent("error", {
      event: "payment_requests.check_failed",
      lane,
      payment_request_id: row.id,
      ...describeError(result?.reason),
    });
  }
  await createSystemPaymentRequestsRepository(env).markPaymentRequestsChecked(stamps);
  logEvent(failed > 0 ? "warn" : "info", {
    event: "payment_requests.lane_run",
    environment: currentClusterScope().environment,
    lane,
    checked: rows.length,
    failed,
    settled,
    blocked,
  });
  return { lane, checked: rows.length, failed };
}
