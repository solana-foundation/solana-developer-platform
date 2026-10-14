import { NextResponse } from "next/server";
import { z } from "zod";
import { deploymentReleaseChannel } from "@/flags/release-channel";
import { findPublishedPlaygroundOperation } from "@/lib/api-playground-openapi-catalog";
import {
  IDEMPOTENCY_KEY_HEADER,
  IDEMPOTENCY_KEY_PATTERN,
  type IdempotencyKeyHeaders,
} from "@/lib/idempotency";
import { PROJECT_HEADER_NAME } from "@/lib/project-cookie";
import { createTimedTrace, logRouteResult } from "@/lib/request-tracing";
import { createSdpApiClient } from "@/lib/sdp-api";
import { getSdpAuth } from "@/lib/sdp-auth";

/**
 * Response headers the playground shows under Headers. An allowlist, not a denylist: anything
 * the API adds later (cookies, internal routing) stays out until someone decides it belongs.
 */
const FORWARDED_RESPONSE_HEADERS = new Set([
  "cache-control",
  "content-length",
  "content-type",
  "date",
  "etag",
  "idempotency-key",
  "idempotent-replayed",
  "location",
  "retry-after",
  "x-ratelimit-limit",
  "x-ratelimit-remaining",
  "x-ratelimit-reset",
  "x-request-id",
  "x-sdp-trace-id",
]);

function forwardedResponseHeaders(headers: Headers): Record<string, string> {
  const forwarded: Record<string, string> = {};
  for (const [name, value] of headers) {
    if (FORWARDED_RESPONSE_HEADERS.has(name)) {
      forwarded[name] = value;
    }
  }
  return forwarded;
}

/**
 * The requested path, parsed as a URL against this request's origin so fetch
 * cannot reinterpret `..` or backslash segments after the allowlist check, or
 * null when it is not an absolute path on that origin.
 */
function normalizeRequestedPath(
  path: string,
  requestUrl: string
): { pathname: string; search: string } | null {
  if (!path.startsWith("/")) return null;
  try {
    const base = new URL(requestUrl);
    const normalizedUrl = new URL(path, base);
    if (normalizedUrl.origin !== base.origin) return null;
    return { pathname: normalizedUrl.pathname, search: normalizedUrl.search };
  } catch {
    return null;
  }
}

/**
 * Playground request envelope. Strict: an envelope from a tab that still sends
 * an `apiKey` (the retired key-paste mode) is refused rather than silently run
 * as the dashboard session. idempotencyKey is the one client-owned header the
 * proxy forwards (as Idempotency-Key, non-GET only): the shell mints one per
 * Send, so the money routes that require it can be called from the playground.
 */
const playgroundExecuteSchema = z.strictObject({
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"], { error: "Invalid method" }),
  path: z.string({ error: "Invalid path" }),
  body: z.unknown().optional(),
  idempotencyKey: z
    .string({ error: "Invalid idempotency key" })
    .trim()
    .regex(IDEMPOTENCY_KEY_PATTERN, {
      error: "Idempotency key must be 1-255 printable ASCII characters",
    })
    .optional(),
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
        "Cache-Control": "private, no-store",
        "X-SDP-Trace-ID": trace.traceId,
        "Server-Timing": trace.serverTiming(),
      },
    }
  );
}

/**
 * Runs one playground request as the signed-in dashboard user, against the
 * Project the calling tab sent as `x-project-id`: the same Clerk session and
 * project header every other dashboard route uses (`createSdpApiClient`), so
 * sdp-api's project context decides whether this member may act on it and
 * their role's permissions apply. No API key is involved, so neither a key's
 * IP allowlist nor its scopes can be bypassed through this hop.
 *
 * Only a published playground catalog operation on this deployment's release
 * channel runs (`findPublishedPlaygroundOperation`); anything else is 404.
 * The only client-owned header forwarded is `Idempotency-Key`, on non-GET
 * requests: the shell mints one per Send and reuses it on a retry, so an
 * ambiguous answer retried cannot become a second transfer. Authorization,
 * project and tracing headers are server-owned.
 */
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
    if (request.headers.get(PROJECT_HEADER_NAME) === null) {
      return failureResponse(trace, 400, `${PROJECT_HEADER_NAME} header required`);
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
    const { method, path: requestedPath, body: requestBody, idempotencyKey } = parsed.data;
    const target = normalizeRequestedPath(requestedPath, request.url);
    const operation =
      target === null
        ? undefined
        : findPublishedPlaygroundOperation(method, target.pathname, deploymentReleaseChannel());
    if (target === null || operation === undefined) {
      return failureResponse(trace, 404, "Not a playground operation");
    }

    const upstreamHeaders: Partial<IdempotencyKeyHeaders> = {};
    if (method !== "GET" && idempotencyKey) {
      upstreamHeaders[IDEMPOTENCY_KEY_HEADER] = idempotencyKey;
    }

    const client = await createSdpApiClient(trace.childContext("route.playground.execute.api"));
    const response = await client.request(`${target.pathname}${target.search}`, {
      method,
      headers: upstreamHeaders,
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
        headers: forwardedResponseHeaders(response.headers),
      },
      {
        headers: {
          "Cache-Control": "private, no-store",
          "X-SDP-Trace-ID": trace.traceId,
          "Server-Timing": trace.serverTiming(),
        },
      }
    );

    logRouteResult(trace, response.status, {
      method,
      // Log the operation, not the user-authored path and query.
      operation: operation.pathTemplate,
      ok: response.ok,
    });

    return nextResponse;
  } catch {
    return failureResponse(trace, 500, "Playground execution failed");
  }
}
