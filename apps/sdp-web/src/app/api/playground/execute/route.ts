import { NextResponse } from "next/server";
import { z } from "zod";
import { createTimedTrace, logRouteResult } from "@/lib/request-tracing";
import { createSdpApiClient, getSdpAuth } from "@/lib/sdp-api";

const PUBLIC_API_PATH_PREFIX = "/v1/";
const INVALID_PATH_MESSAGE = "Path must start with '/v1/'";

function normalizePublicApiPath(path: string, requestUrl: string): string | null {
  if (!path.startsWith("/")) return null;

  try {
    const normalizedUrl = new URL(path, requestUrl);
    if (!normalizedUrl.pathname.startsWith(PUBLIC_API_PATH_PREFIX)) return null;
    return `${normalizedUrl.pathname}${normalizedUrl.search}`;
  } catch {
    return null;
  }
}

/**
 * Playground request envelope. The path is restricted to public /v1 mounts so
 * the proxy cannot replay keys against internal or admin routes. It is parsed
 * as a URL before the mount check so fetch cannot reinterpret traversal
 * segments after validation. apiKey must be non-empty — an absent key
 * previously fell back to the caller's dashboard session, escalating scope
 * past the selected key (Hacktron audit).
 */
const playgroundExecuteSchema = z.object({
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"], { error: "Invalid method" }),
  path: z.string({ error: "Invalid path" }),
  body: z.unknown().optional(),
  apiKey: z
    .string({ error: "API key is required" })
    .trim()
    .min(1, { error: "API key is required" }),
});

/**
 * Ceiling on the playground request envelope. Playground bodies are
 * hand-authored JSON; anything near this size is abuse of the proxy, not a
 * documented API call.
 */
const MAX_REQUEST_BYTES = 256 * 1024;

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

    const rawBody = await request.text();
    if (rawBody.length > MAX_REQUEST_BYTES) {
      return failureResponse(trace, 413, "Request body too large");
    }

    let json: unknown;
    try {
      json = JSON.parse(rawBody);
    } catch {
      return failureResponse(trace, 400, "Invalid JSON body");
    }

    const parsed = playgroundExecuteSchema.safeParse(json);
    if (!parsed.success) {
      return failureResponse(trace, 400, parsed.error.issues[0].message);
    }
    const { method, path: requestedPath, body: requestBody, apiKey } = parsed.data;
    const path = normalizePublicApiPath(requestedPath, request.url);
    if (!path) {
      return failureResponse(trace, 400, INVALID_PATH_MESSAGE);
    }

    const client = await createSdpApiClient(trace.childContext("route.playground.execute.api"));
    const verification = await client.request("/internal/playground/api-key/verify", {
      method: "POST",
      body: JSON.stringify({ apiKey }),
    });
    if (!verification.ok) {
      return failureResponse(trace, 403, "API key is not available for the selected project");
    }

    const response = await client.request(path, {
      method,
      headers: { Authorization: `Bearer ${apiKey}` },
      body:
        method !== "GET" && requestBody !== null && requestBody !== undefined
          ? JSON.stringify(requestBody)
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
