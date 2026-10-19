import type { SdpEnvironment } from "@sdp/types/api-keys";
import { describeError, logEvent } from "@/runtime/money-path-events";

export const CRON_RUN_EVENT = "sdp_cron_run";

/** One registration of a Cron Definition: `global` definitions have no Environment. */
export interface CronRegistration {
  cron: string;
  environment: SdpEnvironment | null;
}

/** A slot's outcome; the statuses and their meanings are `CRON_RUN_STATUSES`. */
export type CronRunRecord =
  | { status: "ok"; durationMs: number }
  | { status: "error"; durationMs: number; cause: unknown }
  | { status: "skipped_overlap" }
  | { status: "disabled" };

/**
 * Log one slot of a Cron Definition to Loki. Every slot logs exactly one event, whatever its
 * status, so liveness alerts can count crons per window.
 *
 * @param registration - The registration whose slot fired.
 * @param record - The slot's outcome.
 */
export function logCronRun(registration: CronRegistration, record: CronRunRecord): void {
  const base = {
    event: CRON_RUN_EVENT,
    cron: registration.cron,
    environment: registration.environment,
    status: record.status,
  };
  switch (record.status) {
    case "ok":
      logEvent("info", { ...base, duration_ms: record.durationMs });
      return;
    case "error":
      logEvent("error", {
        ...base,
        duration_ms: record.durationMs,
        ...describeError(record.cause),
      });
      return;
    case "skipped_overlap":
      logEvent("warn", base);
      return;
    case "disabled":
      logEvent("info", base);
      return;
    default: {
      const unreachable: never = record;
      throw new Error(`Unhandled cron run record: ${JSON.stringify(unreachable)}`);
    }
  }
}
