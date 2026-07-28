import { NextResponse } from "next/server";
import { createTimedTrace, logRouteResult } from "@/lib/request-tracing";
import { createSdpApiClient, getSdpAuth } from "@/lib/sdp-api";

type PlaygroundMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

interface PlaygroundExecuteRequestBody {
  method?: PlaygroundMethod;
  path?: string;
  body?: unknown;
  apiKey?: string | null;
}

const ALLOWED_METHODS = new Set<PlaygroundMethod>(["GET", "POST", "PUT", "PATCH", "DELETE"]);

function failureResponse(
  trace: ReturnType<typeof createTimedTrace>,
  status: number,
  error: string
): NextResponse {
  logRouteResult(trace, status, { error });
  return NextResponse.json(
    { error },
    {
      status,
      headers: {
        "X-SDP-Trace-ID": trace.traceId,
        "Server-Timing": trace.serverTiming(),
      },
    }
  );
}

export async function POST(request: Request) {
  const trace = createTimedTrace("route.playground.execute", request);

  try {
    const { userId, orgId } = await getSdpAuth();
    if (!userId) {
      return failureResponse(trace, 401, "Authentication required");
    }
    if (!orgId) {
      return failureResponse(trace, 403, "Active organization required");
    }

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
    const client = await createSdpApiClient(trace.childContext("route.playground.execute.api"));

    if (normalizedApiKey) {
      const verification = await client.request("/internal/playground/api-key/verify", {
        method: "POST",
        body: JSON.stringify({ apiKey: normalizedApiKey }),
      });
      if (!verification.ok) {
        return failureResponse(trace, 403, "API key is not available for the selected project");
      }
      headers.Authorization = `Bearer ${normalizedApiKey}`;
    }

    const response = await client.request(path, {
      method,
      headers,
      body:
        method !== "GET" &&
        method !== "DELETE" &&
        payload.body !== null &&
        payload.body !== undefined
          ? JSON.stringify(payload.body)
          : undefined,
    });

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
        error: "Playground execution failed",
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
