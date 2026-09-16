import { auth } from "@clerk/nextjs/server";
import type { ListProjectsResponse, Project } from "@sdp/types";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { cache } from "react";
import { readApiErrorMessage } from "./api-error";
import { resolveProjectFromList } from "./dashboard-project-selection";
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

const getRequestProjectCookie = cache(async (): Promise<string | undefined> => {
  const jar = await cookies();
  return jar.get(PROJECT_COOKIE_NAME)?.value;
});

/**
 * The project every request-scoped client sends as `x-project-id`, resolved
 * through the same chain the dashboard layout renders with: the cookie's project
 * while this organization still lists it, else the default sandbox. A stale
 * cookie (two local stacks sharing `localhost`, an archived project, a revoked
 * membership) used to go upstream verbatim and come back as a 403 that every
 * project-scoped page rethrew into the error boundary, while the shell beside it
 * had already fallen back to the sandbox.
 *
 * Takes the caller's already-acquired token rather than minting its own, so one
 * request still mints exactly one. The list is the request-cached `/v1/projects`
 * read the layout already performed, so page renders pay nothing extra; a BFF
 * route handler without that warm cache pays one list call. If the list cannot be
 * loaded there is nothing to validate against, so the cookie's word stands,
 * exactly as the layout treats a failed load as non-authoritative. Nothing here
 * writes the cookie back: cookies cannot be set during a render, and the
 * workspace context's client-side repair effect already does that once the
 * layout flags the mismatch.
 */
const resolveRequestProjectId = cache(async (token: string): Promise<string | undefined> => {
  const cookieProjectId = await getRequestProjectCookie();
  let projects: Project[];
  try {
    projects = await fetchRequestProjects(token);
  } catch {
    return cookieProjectId;
  }
  if (!Array.isArray(projects)) {
    return cookieProjectId;
  }
  return resolveProjectFromList(projects, cookieProjectId)?.id;
});

/**
 * Route handlers that build a project-scoped client outside `proxyToSdpApi`
 * check this first so a missing selection surfaces as a 400 instead of a thrown
 * 500. Without a request-bound token there is no list to validate against, so an
 * unauthenticated caller still reads the raw cookie, as before.
 */
const getRequestSelectedProjectId = cache(async (): Promise<string | undefined> => {
  let token: string;
  try {
    token = await getRequestClerkToken();
  } catch {
    return getRequestProjectCookie();
  }
  return resolveRequestProjectId(token);
});

export function getSelectedProjectId(): Promise<string | undefined> {
  return getRequestSelectedProjectId();
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
 * A missing project is represented by a null project client, so onboarding pages can
 * still query organization state before a project has been selected.
 *
 * `getToken` is optional and should normally be omitted. Passing it bypasses the
 * request-scoped cache that the layout has usually already populated. The parameter
 * stays for callers that hold a token source without a request-bound `auth()` context.
 */
export async function createRequestScopedSdpApiClients({
  getToken,
  organizationTraceContext,
  projectTraceContext,
}: {
  getToken?: ClerkGetToken;
  organizationTraceContext?: TraceContext;
  projectTraceContext?: TraceContext;
} = {}): Promise<{
  organizationClient: SdpApiClient;
  projectClient: SdpApiClient | null;
}> {
  // The project resolution validates the cookie against this organization's project
  // list, so it needs the token first: sequential on purpose, and one mint either way.
  const token = getToken ? await acquireClerkToken(getToken) : await getRequestClerkToken();
  const projectId = await resolveRequestProjectId(token);

  return {
    organizationClient: assembleSdpApiClient(
      createSdpApiRequest(token, null, organizationTraceContext)
    ),
    projectClient: projectId
      ? assembleSdpApiClient(createSdpApiRequest(token, projectId, projectTraceContext))
      : null,
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
 * Creates a project-scoped SDP API client for the project the layout renders
 * with (see `getRequestSelectedProjectId`). Throws only when nothing resolves:
 * no cookie and no sandbox, or an organization with no projects at all.
 * Org-scoped endpoints go through `createOrgSdpApiClient` instead.
 */
export async function createSdpApiClient(traceContext?: TraceContext): Promise<SdpApiClient> {
  const token = await getRequestClerkToken();
  const projectId = await resolveRequestProjectId(token);
  if (!projectId) {
    throw new Error("Selected project required");
  }
  return assembleSdpApiClient(createSdpApiRequest(token, projectId, traceContext));
}

/**
 * Convenience helper for server actions that need to make a raw request to SDP
 * API with the current project and Clerk auth context.
 */
export async function sdpApiRequest(path: string, options: RequestInit = {}): Promise<Response> {
  const apiClient = await createSdpApiClient();
  return apiClient.request(path, options);
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
 * Unauthenticated callers get 401/403; other local failures 500, with the
 * standard `{ error: { message } }` envelope.
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
  const projectId = await getSelectedProjectId();
  if (!projectId) {
    return proxyFailure(trace, 400, "Selected project required");
  }

  try {
    const apiClient = await createSdpApiClient(trace.childContext(`${traceSource}.api`));
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
