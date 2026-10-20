import { NextResponse } from "next/server";
import { deploymentReleaseChannel } from "@/flags/release-channel";
import { findPublishedPlaygroundOperation } from "@/lib/api-playground-openapi-catalog";
import { PLAYGROUND_PROXY_PREFIX, PLAYGROUND_RESPONSE_HEADERS } from "@/lib/api-playground-proxy";
import { IDEMPOTENCY_KEY_HEADER, IDEMPOTENCY_KEY_PATTERN } from "@/lib/idempotency";
import { PROJECT_HEADER_NAME } from "@/lib/project-cookie";
import { createTimedTrace, logRouteResult } from "@/lib/request-tracing";
import { createSdpApiClient, proxyFailure } from "@/lib/sdp-api";
import { getSdpAuth } from "@/lib/sdp-auth";

/**
 * Ceiling on a playground request body. Playground bodies are hand-authored
 * JSON; anything near this size is abuse of the proxy, not a documented API call.
 */
const MAX_REQUEST_BYTES = 256 * 1024;

/**
 * Credentials a caller might still send from the retired key-paste mode. A
 * request carrying one is refused rather than silently run as the session.
 */
const CREDENTIAL_HEADERS = ["authorization", "x-api-key"] as const;

/**
 * Runs one playground request as the signed-in dashboard user, against the
 * Project the calling tab sent as `x-project-id`: the same Clerk session and
 * project header every other dashboard route uses (`createSdpApiClient`), so
 * sdp-api's project context decides whether this member may act on it and
 * their role's permissions apply. No API key is involved, so neither a key's
 * IP allowlist nor its scopes can be bypassed through this hop.
 *
 * `/api/playground/v1/...` runs `/v1/...` with the request's method, query and
 * body. Only a published playground catalog operation on this deployment's
 * release channel runs (`findPublishedPlaygroundOperation`); anything else is
 * 404. The path is read from the request URL, which is already normalized, so
 * `..` or backslash segments cannot reach another route after the allowlist
 * check. The only client-owned header forwarded is `Idempotency-Key`, on
 * non-GET requests: the shell mints one per Send and reuses it on a retry, so
 * an ambiguous answer retried cannot become a second transfer. Authorization,
 * project and tracing headers are server-owned.
 */
async function handle(request: Request): Promise<NextResponse> {
  const trace = createTimedTrace("route.playground.proxy", request);

  try {
    const { userId, orgId } = await getSdpAuth();
    if (!userId) {
      return proxyFailure(trace, 401, "Authentication required");
    }
    if (!orgId) {
      return proxyFailure(trace, 403, "Active organization required");
    }
    if (request.headers.get(PROJECT_HEADER_NAME) === null) {
      return proxyFailure(trace, 400, `${PROJECT_HEADER_NAME} header required`);
    }
    if (CREDENTIAL_HEADERS.some((name) => request.headers.has(name))) {
      return proxyFailure(trace, 400, "The playground runs as your dashboard session");
    }

    const { method } = request;
    const url = new URL(request.url);
    const pathname = url.pathname.slice(PLAYGROUND_PROXY_PREFIX.length);
    const operation = url.pathname.startsWith(`${PLAYGROUND_PROXY_PREFIX}/v1/`)
      ? findPublishedPlaygroundOperation(method, pathname, deploymentReleaseChannel())
      : undefined;
    if (operation === undefined) {
      return proxyFailure(trace, 404, "Not a playground operation");
    }

    const upstreamHeaders = new Headers();
    const idempotencyKey = request.headers.get(IDEMPOTENCY_KEY_HEADER);
    if (method !== "GET" && idempotencyKey !== null) {
      if (!IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
        return proxyFailure(trace, 400, "Idempotency key must be 1-255 printable ASCII characters");
      }
      upstreamHeaders.set(IDEMPOTENCY_KEY_HEADER, idempotencyKey);
    }

    const rawBody = method === "GET" ? "" : await request.text();
    if (rawBody.length > MAX_REQUEST_BYTES) {
      return proxyFailure(trace, 413, "Request body too large");
    }

    const client = await createSdpApiClient(trace.childContext("route.playground.proxy.api"));
    const response = await client.request(`${pathname}${url.search}`, {
      method,
      headers: upstreamHeaders,
      body: rawBody === "" ? undefined : rawBody,
    });

    const headers = new Headers();
    for (const [name, value] of response.headers) {
      if (PLAYGROUND_RESPONSE_HEADERS.has(name)) {
        headers.set(name, value);
      }
    }
    // Per-member API state: never storable by browsers or intermediaries.
    headers.set("Cache-Control", "private, no-store");
    headers.set("X-SDP-Trace-ID", trace.traceId);
    headers.set("Server-Timing", trace.serverTiming());

    logRouteResult(trace, response.status, {
      method,
      // Log the operation, not the user-authored path and query.
      operation: operation.pathTemplate,
      ok: response.ok,
    });

    return new NextResponse(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  } catch {
    return proxyFailure(trace, 500, "Playground execution failed");
  }
}

export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
