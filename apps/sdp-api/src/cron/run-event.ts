/**
 * Proof-of-life for cron ticks: every run emits one structured `sdp_cron_run`
 * event, success or failure, so log-based staleness alerts can fire on absence
 * per monitor. Shared by the managed Cloud Run job (job.ts) and the in-process
 * scheduler (cron/runner.ts).
 */

import { describeError, logEvent } from "@/runtime/money-path-events";

export const CRON_RUN_EVENT = "sdp_cron_run";

export async function runWithCronRunEvent<T>(monitor: string, work: () => Promise<T>): Promise<T> {
  const startedAt = Date.now();
  try {
    const result = await work();
    logEvent("info", {
      event: CRON_RUN_EVENT,
      monitor,
      status: "ok",
      duration_ms: Date.now() - startedAt,
    });
    return result;
  } catch (error) {
    logEvent("error", {
      event: CRON_RUN_EVENT,
      monitor,
      status: "error",
      duration_ms: Date.now() - startedAt,
      ...describeError(error),
    });
    throw error;
  }
}
