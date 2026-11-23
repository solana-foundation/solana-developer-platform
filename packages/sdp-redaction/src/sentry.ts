/**
 * Sentry scrubbing hooks, shared by every `Sentry.init` in the repo.
 *
 * `sentryDataCollection` only stops the SDK from *collecting* PII on its own;
 * everything the application attaches — exception messages, breadcrumb data,
 * span attributes, structured logs, scope context — ships untouched. These
 * hooks are the enforcement point, so a sink cannot be added without one.
 *
 * The hooks are typed structurally rather than against `@sentry/*` so this
 * package stays dependency-free and one object can be spread into
 * `@sentry/node` and `@sentry/nextjs` alike.
 */

import { REDACTED } from "./policy";
import { scrubTelemetry } from "./scrub";

/**
 * Structural keys of a Sentry span that carry no user data. Used only when
 * scrubbing itself fails: `beforeSendSpan` must return a span, so the span is
 * reduced to its skeleton rather than shipped unscrubbed.
 */
const SPAN_SKELETON_KEYS = [
  "span_id",
  "parent_span_id",
  "trace_id",
  "status",
  "is_segment",
  "start_timestamp",
  "end_timestamp",
];

/**
 * Reports only the *type* of failure, never the thrown message.
 *
 * The message is unusable here: this runs because scrubbing did not complete, so
 * nothing has vouched for that string. It can quote the value that broke the
 * walker — a throwing getter, a validator naming its input — which would route
 * unscrubbed PII to stderr from inside the path whose whole job is to fail
 * closed. The constructor name is what a scrubber crash is actually diagnosed
 * from, and it cannot carry a payload.
 */
function reportScrubFailure(kind: string, error: unknown): void {
  const type = error instanceof Error ? error.constructor?.name || error.name : typeof error;
  // Cannot route this through Sentry — we are inside its send path.
  console.error("sdp_telemetry_scrub_failed", { kind, errorType: type });
}

/**
 * Dropping the payload is the correct failure mode: an unscrubbed event is an
 * incident, a missing event is a gap in a dashboard.
 */
function scrubOrDrop<T>(kind: string, payload: T): T | null {
  try {
    return scrubTelemetry(payload);
  } catch (error) {
    reportScrubFailure(kind, error);
    return null;
  }
}

function scrubSpanOrStrip<T>(span: T): T {
  try {
    return scrubTelemetry(span);
  } catch (error) {
    reportScrubFailure("span", error);
    if (!span || typeof span !== "object") {
      return span;
    }
    const source = span as Record<string, unknown>;
    const skeleton: Record<string, unknown> = { name: REDACTED, attributes: {} };
    for (const key of SPAN_SKELETON_KEYS) {
      if (key in source) {
        skeleton[key] = source[key];
      }
    }
    return skeleton as T;
  }
}

export interface SentryScrubbingHooks {
  beforeSend: <T>(event: T) => T | null;
  beforeSendTransaction: <T>(event: T) => T | null;
  beforeSendSpan: <T>(span: T) => T;
  beforeSendLog: <T>(log: T) => T | null;
  beforeSendMetric: <T>(metric: T) => T | null;
  beforeBreadcrumb: <T>(breadcrumb: T) => T | null;
}

/**
 * Passed as `dataCollection` to every `Sentry.init`. The SDK collects every
 * category unless it is switched off here, so a category it adds later arrives
 * switched on: re-read the option's type on each SDK upgrade.
 */
export const sentryDataCollection = {
  userInfo: false,
  cookies: false,
  httpHeaders: false,
  httpBodies: [],
  urlQueryParams: false,
  graphQL: { document: false, variables: false },
  genAI: { inputs: false, outputs: false },
  mcp: { inputs: false, outputs: false },
  databaseQueryData: false,
  queues: false,
  stackFrameVariables: false,
};

/**
 * Spread into `Sentry.init` to cover every payload type the SDK sends: errors,
 * spans, structured logs, metrics, and breadcrumbs. Spans arrive in the SDK's
 * streamed shape; `beforeSendTransaction` only runs under the static trace
 * lifecycle and stays so that switching to it cannot ship unscrubbed transactions.
 */
export const sentryScrubbingHooks: SentryScrubbingHooks = {
  beforeSend: (event) => scrubOrDrop("event", event),
  beforeSendTransaction: (event) => scrubOrDrop("transaction", event),
  beforeSendSpan: (span) => scrubSpanOrStrip(span),
  beforeSendLog: (log) => scrubOrDrop("log", log),
  beforeSendMetric: (metric) => scrubOrDrop("metric", metric),
  beforeBreadcrumb: (breadcrumb) => scrubOrDrop("breadcrumb", breadcrumb),
};
