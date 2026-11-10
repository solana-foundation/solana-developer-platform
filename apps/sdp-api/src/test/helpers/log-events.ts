import { vi } from "vitest";
import { getLogContext, type LogContext } from "@/runtime/logger";
import * as events from "@/runtime/money-path-events";

export type LoggedEvent = [...Parameters<typeof events.logEvent>, LogContext];

/**
 * Silences `logEvent`; the returned reader lists the calls naming one of `eventNames`, in order,
 * each with the request identity its log context held, without the per-request trace ids.
 */
export function recordLoggedEvents(eventNames: readonly string[]): () => LoggedEvent[] {
  const logged: LoggedEvent[] = [];
  vi.spyOn(events, "logEvent").mockImplementation((level, payload) => {
    if (!eventNames.includes(payload.event)) return;
    const {
      request_id: _requestId,
      trace_id: _traceId,
      web_trace_hash: _webTraceHash,
      ...identity
    } = getLogContext();
    logged.push([level, payload, identity]);
  });
  return () => logged;
}
