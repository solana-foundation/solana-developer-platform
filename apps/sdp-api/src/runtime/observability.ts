/**
 * Observability abstraction.
 *
 * This module exposes the small API shape used by application code so tests
 * can inject lightweight implementations. Production wiring uses
 * `noopObservability`: the API's operational signals are structured log
 * events (`sdp_api_*`, `sdp_cron_run`) shipped to Loki, not an error-tracker
 * SDK. Error tracking via Sentry remains a web-only concern (sdp-web).
 */

export interface ObservabilityScope {
  setTag(key: string, value: string | undefined): void;
  setUser(user: { id: string }): void;
}

export interface MonitorOptions {
  schedule:
    | { type: "crontab"; value: string }
    | {
        type: "interval";
        value: number;
        unit: "year" | "month" | "week" | "day" | "hour" | "minute";
      };
  /** Minutes after the expected check-in before the backend marks it missed. */
  checkinMargin?: number;
  /** Minutes before the backend considers an in-progress check-in timed out. */
  maxRuntime?: number;
}

export type MonitorCheckIn =
  | { monitorSlug: string; status: "in_progress" }
  | { monitorSlug: string; status: "ok" | "error"; checkInId: string };

export interface Observability {
  captureException(err: unknown): void;
  withScope(cb: (scope: ObservabilityScope) => void): void;
  withMonitor<T>(slug: string, fn: () => Promise<T>, opts: MonitorOptions): Promise<T>;
}

export interface CheckInObservability extends Observability {
  captureCheckIn(checkIn: MonitorCheckIn, opts?: MonitorOptions): string;
}

const noopScope: ObservabilityScope = {
  setTag() {},
  setUser() {},
};

export const noopObservability: CheckInObservability = {
  captureException() {},
  captureCheckIn() {
    return "";
  },
  withScope(cb) {
    cb(noopScope);
  },
  withMonitor(_slug, fn) {
    return fn();
  },
};
