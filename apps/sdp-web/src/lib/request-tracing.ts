const TRACE_ID_HEADER = "X-SDP-Trace-ID";
const TRACE_SOURCE_HEADER = "X-SDP-Trace-Source";
const TRACE_ID_PATTERN = /^[A-Za-z0-9._:-]+$/;

export interface TraceContext {
  traceId: string;
  source: string;
}

interface TimedTraceStep {
  name: string;
  durationMs: number;
}

function roundDuration(durationMs: number): number {
  return Math.round(durationMs * 10) / 10;
}

function normalizeTraceHeader(value: string | null): string | null {
  if (!value) {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const candidate = trimmed.slice(0, 128);
  if (!TRACE_ID_PATTERN.test(candidate)) {
    return null;
  }

  return candidate;
}

function emitTraceLog(event: string, payload: Record<string, unknown>): void {
  console.info(
    JSON.stringify({
      event,
      timestamp: new Date().toISOString(),
      ...payload,
    })
  );
}

export function getTraceHeaders(context: TraceContext): Record<string, string> {
  return {
    [TRACE_ID_HEADER]: context.traceId,
    [TRACE_SOURCE_HEADER]: context.source,
  };
}

export function resolveTraceContext(source: string, request?: Request): TraceContext {
  const incomingTraceId = normalizeTraceHeader(request?.headers.get(TRACE_ID_HEADER) ?? null);

  return {
    traceId: incomingTraceId ?? `web_${crypto.randomUUID().replaceAll("-", "")}`,
    source,
  };
}

export function createTimedTrace(source: string, request?: Request) {
  const context = resolveTraceContext(source, request);
  const steps: TimedTraceStep[] = [];
  const startedAt = performance.now();

  function elapsedMs(): number {
    return roundDuration(performance.now() - startedAt);
  }

  return {
    ...context,
    childContext(childSource: string): TraceContext {
      return {
        traceId: context.traceId,
        source: childSource,
      };
    },
    async step<T>(name: string, action: () => Promise<T>): Promise<T> {
      const stepStartedAt = performance.now();
      try {
        return await action();
      } finally {
        steps.push({
          name,
          durationMs: roundDuration(performance.now() - stepStartedAt),
        });
      }
    },
    elapsedMs,
    serverTiming(metric = "app"): string {
      return `${metric};dur=${elapsedMs()}`;
    },
    log(extra: Record<string, unknown> = {}): void {
      emitTraceLog("sdp_web_timed_trace", {
        traceId: context.traceId,
        source,
        durationMs: elapsedMs(),
        steps,
        ...extra,
      });
    },
  };
}

export function logRouteResult(
  trace: TraceContext & { elapsedMs(): number },
  status: number,
  extra: Record<string, unknown> = {}
): void {
  emitTraceLog("sdp_web_route_timing", {
    traceId: trace.traceId,
    source: trace.source,
    status,
    durationMs: trace.elapsedMs(),
    ...extra,
  });
}

export { TRACE_ID_HEADER, TRACE_SOURCE_HEADER };
