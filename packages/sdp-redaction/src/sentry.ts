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
    const skeleton: Record<string, unknown> = { description: REDACTED };
    for (const key of SPAN_SKELETON_KEYS) {
      if (key in source) {
        skeleton[key] = source[key];
      }
    }
    return skeleton as T;
  }
}

/**
 * Feedback is the one payload the SDK never feeds to an init option:
 * `captureFeedback` emits the `beforeSendFeedback` hook on the client and then
 * captures the same object, and `emit` ignores hook return values. A fresh
 * scrubbed copy would be discarded and the raw event sent, so the scrubbed
 * properties are written back into the event itself.
 *
 * The hook still cannot drop the event on failure the way the other hooks do —
 * a null return reaches nothing — so it fails closed like `beforeSendSpan`:
 * the event is reduced to its bare feedback skeleton, which carries no user
 * data.
 */
function scrubFeedbackInPlace<T>(event: T): T {
  if (!event || typeof event !== "object") {
    // Real feedback events are always objects (the SDK builds them), so this
    // branch is best-effort for impossible shapes: nothing can be mutated in
    // place and a null return would be ignored anyway.
    return scrubOrDrop("feedback", event) ?? event;
  }
  const target = event as Record<string, unknown>;
  try {
    const scrubbed = scrubTelemetry(event) as Record<string, unknown>;
    for (const key of Object.keys(target)) {
      delete target[key];
    }
    Object.assign(target, scrubbed);
    return event;
  } catch (error) {
    reportScrubFailure("feedback", error);
    for (const key of Object.keys(target)) {
      delete target[key];
    }
    target.type = "feedback";
    target.level = "info";
    return event;
  }
}

export interface SentryScrubbingHooks {
  beforeSend: <T>(event: T) => T | null;
  beforeSendTransaction: <T>(event: T) => T | null;
  beforeSendSpan: <T>(span: T) => T;
  beforeSendLog: <T>(log: T) => T | null;
  beforeSendMetric: <T>(metric: T) => T | null;
  beforeBreadcrumb: <T>(breadcrumb: T) => T | null;
  /**
   * Not consumed as an init option: register it with
   * `client.on("beforeSendFeedback", sentryScrubbingHooks.beforeSendFeedback)`
   * after `Sentry.init`. It scrubs the event in place and returns it, because
   * the SDK ignores hook return values.
   */
  beforeSendFeedback: <T>(event: T) => T;
}

/**
 * Spread into `Sentry.init` to cover every payload type the SDK sends: errors,
 * transactions, spans, structured logs, metrics, and breadcrumbs — plus
 * feedback events, which the SDK delivers only through the `beforeSendFeedback`
 * client hook, so that one member must also be registered on the client
 * (`Sentry.getClient()?.on("beforeSendFeedback", ...)`).
 */
export const sentryScrubbingHooks: SentryScrubbingHooks = {
  beforeSend: (event) => scrubOrDrop("event", event),
  beforeSendTransaction: (event) => scrubOrDrop("transaction", event),
  beforeSendSpan: (span) => scrubSpanOrStrip(span),
  beforeSendLog: (log) => scrubOrDrop("log", log),
  beforeSendMetric: (metric) => scrubOrDrop("metric", metric),
  beforeBreadcrumb: (breadcrumb) => scrubOrDrop("breadcrumb", breadcrumb),
  beforeSendFeedback: (event) => scrubFeedbackInPlace(event),
};
