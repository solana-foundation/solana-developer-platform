import { installLogLineCapture } from "@/test/helpers/log-lines";

/**
 * The lines naming one of `eventNames`, as {@link installLogLineCapture} writes them, without the
 * values that vary per request or repeat the event; register at `describe` level.
 */
export function recordLoggedEvents(eventNames: readonly string[]): () => Record<string, unknown>[] {
  const lines = installLogLineCapture();
  return () =>
    lines
      .filter((line) => eventNames.some((name) => name === line.event))
      .map(
        ({
          time: _time,
          level: _level,
          message: _message,
          request_id: _requestId,
          trace_id: _traceId,
          web_trace_hash: _webTraceHash,
          route: _route,
          ...line
        }) => line
      );
}
