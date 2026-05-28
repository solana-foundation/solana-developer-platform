import { auth } from "@clerk/nextjs/server";
import { cookies } from "next/headers";
import { PROJECT_COOKIE_NAME, PROJECT_HEADER_NAME } from "./project-cookie";
import { TRACE_ID_HEADER, TRACE_SOURCE_HEADER, type TraceContext } from "./request-tracing";

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

async function getClerkToken(): Promise<string> {
  const { getToken, orgId } = await auth();
  if (!orgId) {
    throw new Error("Active Clerk organization required");
  }

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

async function getSelectedProjectId(): Promise<string | null> {
  const jar = await cookies();
  return jar.get(PROJECT_COOKIE_NAME)?.value ?? null;
}

export async function createSdpApiClient(traceContext?: TraceContext): Promise<SdpApiClient> {
  const token = await getClerkToken();
  const projectId = await getSelectedProjectId();
  const request = createSdpApiRequest(token, projectId, traceContext);

  return {
    request,
    fetch: async <T>(path: string, options: RequestInit = {}): Promise<T> => {
      const res = await request(path, options);
      return parseSdpApiResponse<T>(res);
    },
  };
}

export async function sdpApiRequest(
  path: string,
  options: RequestInit = {},
  traceContext?: TraceContext
): Promise<Response> {
  const client = await createSdpApiClient(traceContext);
  return client.request(path, options);
}

export async function sdpApiFetch<T>(
  path: string,
  options: RequestInit = {},
  traceContext?: TraceContext
): Promise<T> {
  const client = await createSdpApiClient(traceContext);
  const res = await client.request(path, options);
  return parseSdpApiResponse<T>(res);
}
