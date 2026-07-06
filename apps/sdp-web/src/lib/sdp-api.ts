import { auth } from "@clerk/nextjs/server";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { PROJECT_COOKIE_NAME, PROJECT_HEADER_NAME } from "./project-cookie";
import {
  createTimedTrace,
  logRouteResult,
  TRACE_ID_HEADER,
  TRACE_SOURCE_HEADER,
  type TraceContext,
} from "./request-tracing";

function getApiBaseUrl(): string {
  const base =
    process.env.SDP_API_BASE_URL ||
    process.env.NEXT_PUBLIC_SDP_API_BASE_URL ||
    process.env.NEXT_PUBLIC_API_BASE_URL;

  if (!base) {
    throw new Error("SDP_API_BASE_URL is not configured");
  }

  return base.replace(/\/$/, "");
}

type ClerkGetToken = (options?: { template?: string }) => Promise<string | null>;

/**
 * Acquires the sdp-api bearer token from a Clerk `getToken`, honoring
 * CLERK_JWT_TEMPLATE when configured. Takes `getToken` as a parameter because
 * server contexts get it from `auth()` while the proxy middleware gets it from
 * its `clerkMiddleware` callback.
 */
export async function acquireClerkToken(getToken: ClerkGetToken): Promise<string> {
  const template = process.env.CLERK_JWT_TEMPLATE;
  if (template) {
    const token = await getToken({ template });
    if (!token) {
      throw new Error(`Failed to acquire Clerk token from template '${template}'`);
    }
    return token;
  }

  const token = await getToken();
  if (!token) {
    throw new Error("Failed to acquire Clerk token");
  }

  return token;
}

async function getClerkToken(): Promise<string> {
  const { getToken, orgId } = await auth();
  if (!orgId) {
    throw new Error("Active Clerk organization required");
  }
  return acquireClerkToken(getToken);
}

type SdpApiRequestFn = (path: string, options?: RequestInit) => Promise<Response>;

function roundDuration(durationMs: number): number {
  return Math.round(durationMs * 10) / 10;
}

function createTraceRequestId(traceId: string, sequence: number): string {
  const suffix = sequence.toString().padStart(2, "0");
  return `${traceId}:${suffix}`.slice(0, 128);
}

function createSdpApiRequest(
  token: string,
  projectId: string | null,
  traceContext?: TraceContext
): SdpApiRequestFn {
  let requestSequence = 0;

  return async (path: string, options: RequestInit = {}): Promise<Response> => {
    const url = `${getApiBaseUrl()}${path.startsWith("/") ? path : `/${path}`}`;
    requestSequence += 1;

    const traceId = traceContext?.traceId ?? `web_${crypto.randomUUID().replaceAll("-", "")}`;
    const requestId = createTraceRequestId(traceId, requestSequence);
    const source = traceContext?.source ?? "sdp-web";
    const headers = new Headers(options.headers);
    if (!headers.has("Authorization")) {
      headers.set("Authorization", `Bearer ${token}`);
    }
    headers.set("Content-Type", "application/json");
    headers.set(TRACE_ID_HEADER, traceId);
    headers.set(TRACE_SOURCE_HEADER, source);
    headers.set("X-Request-ID", requestId);
    if (projectId && !headers.has(PROJECT_HEADER_NAME)) {
      headers.set(PROJECT_HEADER_NAME, projectId);
    }
    const startedAt = performance.now();
    const method = options.method ?? "GET";

    const response = await fetch(url, {
      ...options,
      headers,
      cache: "no-store",
    });

    console.info(
      JSON.stringify({
        event: "sdp_web_api_request",
        timestamp: new Date().toISOString(),
        traceId,
        source,
        requestId,
        method,
        path,
        status: response.status,
        durationMs: roundDuration(performance.now() - startedAt),
        upstreamRequestId: response.headers.get("X-Request-ID"),
        upstreamServerTiming: response.headers.get("Server-Timing"),
      })
    );

    return response;
  };
}

async function parseSdpApiResponse<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`SDP API request failed (${res.status}): ${body}`);
  }

  if (res.status === 204) {
    return {} as T;
  }

  const json = (await res.json()) as unknown;

  if (json && typeof json === "object" && "data" in json) {
    return (json as { data: T }).data;
  }

  return json as T;
}

export interface SdpApiClient {
  request: SdpApiRequestFn;
  fetch: <T>(path: string, options?: RequestInit) => Promise<T>;
}

/**
 * Reads the selected project id from the project cookie. Route handlers that
 * build a project-scoped client outside `proxyToSdpApi` check this first so a
 * missing selection surfaces as a 400 instead of a thrown 500.
 */
export async function getSelectedProjectId(): Promise<string | undefined> {
  const jar = await cookies();
  return jar.get(PROJECT_COOKIE_NAME)?.value;
}

function assembleSdpApiClient(request: SdpApiRequestFn): SdpApiClient {
  return {
    request,
    fetch: async <T>(path: string, options: RequestInit = {}): Promise<T> => {
      const res = await request(path, options);
      return parseSdpApiResponse<T>(res);
    },
  };
}

async function buildSdpApiClient(
  projectId: string | null,
  traceContext?: TraceContext
): Promise<SdpApiClient> {
  const token = await getClerkToken();
  return assembleSdpApiClient(createSdpApiRequest(token, projectId, traceContext));
}

/**
 * Creates an org-scoped client from an explicit bearer token, for the proxy
 * middleware where Clerk's request-bound `auth()` helper is unavailable.
 */
export function createTokenSdpApiClient(token: string): SdpApiClient {
  return assembleSdpApiClient(createSdpApiRequest(token, null));
}

/**
 * Creates a project-scoped SDP API client. Throws when no project is
 * selected — org-scoped endpoints go through `createOrgSdpApiClient` instead.
 */
export async function createSdpApiClient(traceContext?: TraceContext): Promise<SdpApiClient> {
  const projectId = await getSelectedProjectId();
  if (!projectId) {
    throw new Error("Selected project required");
  }
  return buildSdpApiClient(projectId, traceContext);
}

/**
 * Creates an org-scoped SDP API client (no project header) for the endpoints
 * that exist outside any project: projects, members, allowlist, organizations.
 */
export async function createOrgSdpApiClient(traceContext?: TraceContext): Promise<SdpApiClient> {
  return buildSdpApiClient(null, traceContext);
}

function proxyFailure(
  trace: ReturnType<typeof createTimedTrace>,
  status: number,
  message: string
): NextResponse {
  logRouteResult(trace, status, { error: message });
  return NextResponse.json(
    { error: { message } },
    {
      status,
      headers: { "X-SDP-Trace-ID": trace.traceId, "Server-Timing": trace.serverTiming() },
    }
  );
}

/**
 * Proxies a dashboard API route to sdp-api: forwards the incoming method and
 * body to `path` and streams the upstream response back with trace headers.
 * Unauthenticated callers get 401/403; other local failures 500, with the
 * standard `{ error: { message } }` envelope.
 */
export async function proxyToSdpApi({
  request,
  traceSource,
  path,
}: {
  request: Request;
  traceSource: string;
  path: string;
}): Promise<NextResponse> {
  const trace = createTimedTrace(traceSource, request);

  const { userId, orgId } = await auth();
  if (!userId) {
    return proxyFailure(trace, 401, "Authentication required");
  }
  if (!orgId) {
    return proxyFailure(trace, 403, "Active organization required");
  }
  const projectId = await getSelectedProjectId();
  if (!projectId) {
    return proxyFailure(trace, 400, "Selected project required");
  }

  try {
    const apiClient = await createSdpApiClient(trace.childContext(`${traceSource}.api`));
    const method = request.method;
    const body = method === "GET" || method === "HEAD" ? undefined : await request.text();
    const response = await apiClient.request(path, { method, body });

    logRouteResult(trace, response.status);

    return new NextResponse(response.body, {
      status: response.status,
      headers: {
        "Content-Type": response.headers.get("Content-Type") ?? "application/json",
        "X-SDP-Trace-ID": trace.traceId,
        "Server-Timing": trace.serverTiming(),
      },
    });
  } catch (error) {
    return proxyFailure(
      trace,
      500,
      error instanceof Error ? error.message : "SDP API proxy request failed"
    );
  }
}
