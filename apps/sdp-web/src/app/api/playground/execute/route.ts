import { NextResponse } from "next/server";
import { createTimedTrace, logRouteResult } from "@/lib/request-tracing";
import { sdpApiRequest } from "@/lib/sdp-api";

type PlaygroundMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

interface PlaygroundExecuteRequestBody {
  method?: PlaygroundMethod;
  path?: string;
  body?: unknown;
  apiKey?: string | null;
}

const ALLOWED_METHODS = new Set<PlaygroundMethod>(["GET", "POST", "PUT", "PATCH", "DELETE"]);

export async function POST(request: Request) {
  const trace = createTimedTrace("route.playground.execute", request);

  try {
    const payload = (await request.json()) as PlaygroundExecuteRequestBody;
    const method = payload.method;
    const path = payload.path;

    if (!method || !ALLOWED_METHODS.has(method)) {
      const response = NextResponse.json(
        { error: "Invalid method" },
        {
          status: 400,
          headers: {
            "X-SDP-Trace-ID": trace.traceId,
            "Server-Timing": trace.serverTiming(),
          },
        }
      );
      logRouteResult(trace, 400, { error: "Invalid method" });
      return response;
    }

    if (!path || typeof path !== "string") {
      const response = NextResponse.json(
        { error: "Invalid path" },
        {
          status: 400,
          headers: {
            "X-SDP-Trace-ID": trace.traceId,
            "Server-Timing": trace.serverTiming(),
          },
        }
      );
      logRouteResult(trace, 400, { error: "Invalid path" });
      return response;
    }
    if (!path.startsWith("/")) {
      const response = NextResponse.json(
        { error: "Path must start with '/'" },
        {
          status: 400,
          headers: {
            "X-SDP-Trace-ID": trace.traceId,
            "Server-Timing": trace.serverTiming(),
          },
        }
      );
      logRouteResult(trace, 400, { error: "Path must start with '/'" });
      return response;
    }

    const normalizedApiKey = typeof payload.apiKey === "string" ? payload.apiKey.trim() : "";
    const headers: Record<string, string> = {};

    if (normalizedApiKey) {
      headers.Authorization = `Bearer ${normalizedApiKey}`;
    }

    const response = await sdpApiRequest(
      path,
      {
        method,
        headers,
        body:
          method !== "GET" &&
          method !== "DELETE" &&
          payload.body !== null &&
          payload.body !== undefined
            ? JSON.stringify(payload.body)
            : undefined,
      },
      trace.childContext("route.playground.execute.api")
    );

    const text = await response.text();
    const body = text
      ? (() => {
          try {
            return JSON.parse(text) as unknown;
          } catch {
            return text;
          }
        })()
      : {};

    const nextResponse = NextResponse.json(
      {
        ok: response.ok,
        status: response.status,
        statusText: response.statusText,
        body,
      },
      {
        headers: {
          "X-SDP-Trace-ID": trace.traceId,
          "Server-Timing": trace.serverTiming(),
        },
      }
    );

    logRouteResult(trace, response.status, {
      method,
      path,
      ok: response.ok,
    });

    return nextResponse;
  } catch (error) {
    const response = NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Playground execution failed",
      },
      {
        status: 500,
        headers: {
          "X-SDP-Trace-ID": trace.traceId,
          "Server-Timing": trace.serverTiming(),
        },
      }
    );
    logRouteResult(trace, 500, {
      error: error instanceof Error ? error.message : "Playground execution failed",
    });
    return response;
  }
}
