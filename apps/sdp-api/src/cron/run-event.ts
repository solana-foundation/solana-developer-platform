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
