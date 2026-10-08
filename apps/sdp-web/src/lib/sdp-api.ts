import { auth } from "@clerk/nextjs/server";
import type { ListProjectsResponse, Project } from "@sdp/types";
import { NextResponse } from "next/server";
import { cache } from "react";
import { readApiErrorMessage } from "./api-error";
import { PROJECT_HEADER_NAME } from "./project-cookie";
import {
  createTimedTrace,
  logRouteResult,
  TRACE_ID_HEADER,
  TRACE_SOURCE_HEADER,
  type TraceContext,
} from "./request-tracing";
import { findSdpApiBaseUrl } from "./sdp-api-base-url";

function getApiBaseUrl(): string {
  const base = findSdpApiBaseUrl({
    SDP_API_BASE_URL: process.env.SDP_API_BASE_URL,
    NEXT_PUBLIC_SDP_API_BASE_URL: process.env.NEXT_PUBLIC_SDP_API_BASE_URL,
    NEXT_PUBLIC_API_BASE_URL: process.env.NEXT_PUBLIC_API_BASE_URL,
  });
  if (!base) {
    throw new Error("SDP_API_BASE_URL is not configured");
  }
  return base;
}

type ClerkGetToken = () => Promise<string | null>;

/**
 * Acquires the sdp-api bearer token: the Clerk session token, whose custom
 * claims (org_id, org_role, org_slug, email) come from the instance's
 * session-token customization. Takes `getToken` as a parameter because server
 * contexts get it from `auth()` while the proxy middleware gets it from its
 * `clerkMiddleware` callback.
 */
export async function acquireClerkToken(getToken: ClerkGetToken): Promise<string> {
  const token = await getToken();
  if (!token) {
    throw new Error("Failed to acquire Clerk token");
  }

  return token;
}

const getRequestAuth = cache(async () => auth());

export function getSdpAuth() {
  return getRequestAuth();
}

const getRequestClerkToken = cache(async (): Promise<string> => {
  const { getToken, orgId } = await getRequestAuth();
  if (!orgId) {
    throw new Error("Active Clerk organization required");
  }
  return acquireClerkToken(getToken);
});

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
    if (options.body !== undefined && options.body !== null) {
      headers.set("Content-Type", "application/json");
    }
    headers.set(TRACE_ID_HEADER, traceId);
    headers.set(TRACE_SOURCE_HEADER, source);
    headers.set("X-Request-ID", requestId);
    if (projectId && !headers.has(PROJECT_HEADER_NAME)) {
      headers.set(PROJECT_HEADER_NAME, projectId);
    }
    const startedAt = performance.now();
    const method = options.method ?? "GET";
    // The query string is caller-supplied and may carry a pasted credential
    // (e.g. a playground request); the log keeps the route only while the
    // upstream request still receives the full path.
    const loggedPath = path.split("?", 1)[0];

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
        path: loggedPath,
        status: response.status,
        durationMs: roundDuration(performance.now() - startedAt),
        upstreamRequestId: response.headers.get("X-Request-ID"),
        upstreamServerTiming: response.headers.get("Server-Timing"),
      })
    );

    return response;
  };
}

export class SdpApiResponseError extends Error {
  constructor(
    readonly status: number,
    readonly responseBody: string
  ) {
    super(`SDP API request failed (${status}): ${responseBody}`);
    this.name = "SdpApiResponseError";
  }
}

async function parseSdpApiResponse<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.text();
    throw new SdpApiResponseError(res.status, body);
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

/**
 * Pull a human-readable message out of the `SDP API request failed (N): {body}`
 * error thrown by {@link parseSdpApiResponse}: prefer the JSON `error.message`,
 * then the raw body, then the original error text.
 */
export function extractSdpApiErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) return "Unknown error.";
  const match = /^SDP API request failed \(\d+\):\s*([\s\S]*)$/.exec(error.message);
  if (!match) return error.message;
  const body = match[1] ?? "";
  try {
    const payload: unknown = JSON.parse(body);
    return readApiErrorMessage(payload) ?? (body || error.message);
  } catch {
    return body || error.message;
  }
}

/**
 * The same unwrapping as {@link extractSdpApiErrorMessage}, but keeping the
 * status alongside the message.
 *
 * Callers that must tell a conclusive refusal from an outcome that may still
 * have committed need the code, not just the text: under 500 (and not 408 or
 * 429) the server answered and nothing was written; anything else leaves the
 * question open. A `null` status means no response was attributable at all,
 * which belongs on the open side of that line.
 */
export function extractSdpApiError(error: unknown): { status: number | null; message: string } {
  if (error instanceof SdpApiResponseError) {
    return { status: error.status, message: extractSdpApiErrorMessage(error) };
  }
  if (!(error instanceof Error)) {
    return { status: null, message: "Unknown error." };
  }
  // Errors that crossed a server-action boundary arrive as plain Errors with
  // the constructor's message text but no prototype, so the status has to come
  // back out of the string.
  const match = /^SDP API request failed \((\d+)\):/.exec(error.message);
  return {
    status: match ? Number.parseInt(match[1] ?? "", 10) : null,
    message: extractSdpApiErrorMessage(error),
  };
}

export interface SdpApiClient {
  request: SdpApiRequestFn;
  fetch: <T>(path: string, options?: RequestInit) => Promise<T>;
}

// Keyed by token so the layout's bootstrap list and the project resolution below
// share one request-cached read: both hand in the same request-bound token.
const fetchRequestProjects = cache(async (token: string): Promise<Project[]> => {
  const client = assembleSdpApiClient(
    createSdpApiRequest(token, null, {
      traceId: `web_${crypto.randomUUID().replaceAll("-", "")}`,
      source: "dashboard.projects.bootstrap",
    })
  );
  const response = await client.fetch<ListProjectsResponse>("/v1/projects");
  return response.projects;
});

const getRequestProjects = cache(
  async (): Promise<Project[]> => await fetchRequestProjects(await getRequestClerkToken())
);

export function listSdpProjects(): Promise<Project[]> {
  return getRequestProjects();
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

/**
 * Org- and project-scoped clients for one request, built from one request-bound Clerk
 * token so the same token is not acquired twice, and without a project header on the
 * organization client.
 *
 * @param params.projectId - Project the page renders, from its route params.
 * @param params.organizationTraceContext - Trace for the organization client's requests.
 * @param params.projectTraceContext - Trace for the project client's requests.
 * @returns The organization client and the client pinned to `projectId`.
 */
export async function createRequestScopedSdpApiClients({
  projectId,
  organizationTraceContext,
  projectTraceContext,
}: {
  projectId: string;
  organizationTraceContext?: TraceContext;
  projectTraceContext?: TraceContext;
}): Promise<{
  organizationClient: SdpApiClient;
  projectClient: SdpApiClient;
}> {
  const token = await getRequestClerkToken();
  return {
    organizationClient: assembleSdpApiClient(
      createSdpApiRequest(token, null, organizationTraceContext)
    ),
    projectClient: assembleSdpApiClient(createSdpApiRequest(token, projectId, projectTraceContext)),
  };
}

async function buildSdpApiClient(
  projectId: string | null,
  traceContext?: TraceContext
): Promise<SdpApiClient> {
  const token = await getRequestClerkToken();
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
 * Creates a client pinned to the project the calling tab renders, for route
 * handlers and server actions. The id is relayed upstream as `x-project-id`
 * unchecked: sdp-api's project context is the only authority on whether this
 * caller may act on it, so a project the caller cannot reach comes back as the
 * API's own refusal rather than being guessed at here (HOO-1965).
 *
 * @param projectId - Project the tab renders, from its URL or request header.
 * @param traceContext - Trace to attach the upstream requests to.
 * @returns A client whose every request carries `projectId`.
 */
export async function createProjectBoundSdpApiClient(
  projectId: string,
  traceContext?: TraceContext
): Promise<SdpApiClient> {
  const token = await getRequestClerkToken();
  return assembleSdpApiClient(createSdpApiRequest(token, projectId, traceContext));
}

/**
 * Creates an org-scoped SDP API client (no project header) for the endpoints
 * that exist outside any project: projects, members, allowlist, organizations.
 */
export async function createOrgSdpApiClient(traceContext?: TraceContext): Promise<SdpApiClient> {
  return buildSdpApiClient(null, traceContext);
}

export function proxyFailure(
  trace: ReturnType<typeof createTimedTrace>,
  status: number,
  message: string
): NextResponse {
  logRouteResult(trace, status, { error: message });
  return NextResponse.json(
    { error: { message } },
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
 * Proxies a dashboard API route to sdp-api: forwards the incoming method and
 * body to `path` and streams the upstream response back with trace headers.
 * The project is the one the calling tab sent as `x-project-id`, never the
 * shared selection cookie, so a tab rendering project A keeps acting on A after
 * another tab switches to B. Unauthenticated callers get 401/403, a request
 * without the header 400, other local failures 500, with the standard
 * `{ error: { message } }` envelope.
 */
export async function proxyToSdpApi({
  request,
  traceSource,
  path,
  upstreamHeaders,
}: {
  request: Request;
  traceSource: string;
  path: string;
  /**
   * Headers deliberately selected by the route handler for the upstream API.
   * The proxy never copies the incoming header bag: auth, project and tracing
   * remain server-owned, while endpoint-specific metadata is opt-in.
   */
  upstreamHeaders?: HeadersInit;
}): Promise<NextResponse> {
  const trace = createTimedTrace(traceSource, request);

  const { userId, orgId } = await auth();
  if (!userId) {
    return proxyFailure(trace, 401, "Authentication required");
  }
  if (!orgId) {
    return proxyFailure(trace, 403, "Active organization required");
  }
  const projectId = request.headers.get(PROJECT_HEADER_NAME);
  if (!projectId) {
    return proxyFailure(trace, 400, `${PROJECT_HEADER_NAME} header required`);
  }

  try {
    const apiClient = await createProjectBoundSdpApiClient(
      projectId,
      trace.childContext(`${traceSource}.api`)
    );
    const method = request.method;
    const rawBody = method === "GET" || method === "HEAD" ? "" : await request.text();
    const response = await apiClient.request(path, {
      method,
      body: rawBody === "" ? undefined : rawBody,
      headers: upstreamHeaders,
    });

    logRouteResult(trace, response.status);

    return new NextResponse(response.body, {
      status: response.status,
      headers: {
        "Content-Type": response.headers.get("Content-Type") ?? "application/json",
        // Per-org financial state: never storable by browsers or intermediaries.
        "Cache-Control": "private, no-store",
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
