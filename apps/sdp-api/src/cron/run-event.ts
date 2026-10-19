import type { SdpEnvironment } from "@sdp/types/api-keys";
import type { CronRunStatus } from "@sdp/types/cron-runs";
import { describeError, logEvent } from "@/runtime/money-path-events";

export const CRON_RUN_EVENT = "sdp_cron_run";

/** One registration of a Cron Definition: `global` definitions have no Environment. */
export interface CronRegistration {
  cron: string;
  environment: SdpEnvironment | null;
}

/** A slot's outcome; the statuses and their meanings are `CRON_RUN_STATUSES`. */
export type CronRunRecord =
  | { status: Extract<CronRunStatus, "ok">; durationMs: number }
  | { status: Extract<CronRunStatus, "error">; durationMs: number; cause: unknown }
  | { status: Extract<CronRunStatus, "skipped_overlap"> }
  | { status: Extract<CronRunStatus, "disabled"> };

/** Every status in `CRON_RUN_STATUSES` must have a level here, so the set and the logger cannot drift. */
const CRON_RUN_LOG_LEVELS = {
  ok: "info",
  error: "error",
  skipped_overlap: "warn",
  disabled: "info",
} as const satisfies Record<CronRunStatus, "info" | "warn" | "error">;

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
    // Transitional: the pre-ADR-0011 field, kept for one release so the live sdp-infra alerts
    // (keyed on `jsonPayload_monitor`) and the renamed ones (keyed on `cron`) both match whatever
    // order the API and alert deploys land in, and across a rollback. Drop it once the renamed
    // alerts are live (HOO-2165).
    monitor: `sdp-api-${registration.cron}`,
  };
  switch (record.status) {
    case "ok":
      logEvent(CRON_RUN_LOG_LEVELS.ok, { ...base, duration_ms: record.durationMs });
      return;
    case "error":
      logEvent(CRON_RUN_LOG_LEVELS.error, {
        ...base,
        duration_ms: record.durationMs,
        ...describeError(record.cause),
      });
      return;
    case "skipped_overlap":
      logEvent(CRON_RUN_LOG_LEVELS.skipped_overlap, base);
      return;
    case "disabled":
      logEvent(CRON_RUN_LOG_LEVELS.disabled, base);
      return;
    default: {
      const unreachable: never = record;
      throw new Error(`Unhandled cron run record: ${JSON.stringify(unreachable)}`);
    }
  }
}
