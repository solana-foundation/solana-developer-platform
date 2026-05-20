const TRACE_ID_HEADER = "X-SDP-Trace-ID";
const TRACE_SOURCE_HEADER = "X-SDP-Trace-Source";
const TRACE_ID_PATTERN = /^[A-Za-z0-9._:-]+$/;

export interface TraceContext {
  traceId: string;
  source: string;
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
      void name;
      return action();
    },
    elapsedMs,
    serverTiming(metric = "app"): string {
      return `${metric};dur=${elapsedMs()}`;
    },
    log(extra: Record<string, unknown> = {}): void {
      void extra;
    },
  };
}

export function logRouteResult(
  trace: TraceContext & { elapsedMs(): number },
  status: number,
  extra: Record<string, unknown> = {}
): void {
  void trace;
  void status;
  void extra;
}

export { TRACE_ID_HEADER, TRACE_SOURCE_HEADER };
