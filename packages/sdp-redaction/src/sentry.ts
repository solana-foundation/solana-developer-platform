/**
 * Sentry scrubbing hooks, shared by every `Sentry.init` in the repo.
 *
 * `sendDefaultPii: false` only stops the SDK from *collecting* PII on its own;
 * everything the application attaches — exception messages, breadcrumb data,
 * span attributes, structured logs, scope context — ships untouched. These
 * hooks are the enforcement point, so a sink cannot be added without one.
 *
 * The hooks are typed structurally rather than against `@sentry/*` so this
 * package stays dependency-free and one object can be spread into
 * `@sentry/node` and `@sentry/nextjs` alike.
 */

import { redactCredentialString } from "./credentials";
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
  "segment_id",
  "op",
  "status",
  "origin",
  "is_segment",
  "start_timestamp",
  "timestamp",
];

function reportScrubFailure(kind: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  // Cannot route this through Sentry — we are inside its send path.
  console.error("sdp_telemetry_scrub_failed", {
    kind,
    error: redactCredentialString(message),
  });
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
    const skeleton: Record<string, unknown> = { description: REDACTED };
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
 * Spread into `Sentry.init` to cover every payload type the SDK sends: errors,
 * transactions, spans, structured logs, metrics, and breadcrumbs.
 */
export const sentryScrubbingHooks: SentryScrubbingHooks = {
  beforeSend: (event) => scrubOrDrop("event", event),
  beforeSendTransaction: (event) => scrubOrDrop("transaction", event),
  beforeSendSpan: (span) => scrubSpanOrStrip(span),
  beforeSendLog: (log) => scrubOrDrop("log", log),
  beforeSendMetric: (metric) => scrubOrDrop("metric", metric),
  beforeBreadcrumb: (breadcrumb) => scrubOrDrop("breadcrumb", breadcrumb),
};
