import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { createTimedTrace } from "@/lib/request-tracing";
import { createSdpApiClient, getSelectedProjectId, proxyFailure } from "@/lib/sdp-api";

// Pass-through proxy from a Next route handler to an sdp-api webhook-endpoints
// endpoint (the outbound-webhook registry).
//
// The auth pre-check mirrors `proxyToSdpApi`: without it, `createSdpApiClient` throws on
// a signed-out or org-less caller and Next renders an opaque 500, so the client can't
// tell "sign in again" from "the API is down". Trace headers go out on every response for
// the same reason every other dashboard route emits them.
export async function proxyWebhooks(
  request: Request,
  apiPath: string,
  init?: { method?: "GET" | "POST" | "PATCH" | "DELETE"; body?: unknown; traceName?: string }
): Promise<Response> {
  const method = init?.method ?? "GET";
  const trace = createTimedTrace(init?.traceName ?? `route.webhooks.proxy.${method}`, request);

  const { userId, orgId } = await auth();
  if (!userId) {
    return proxyFailure(trace, 401, "Authentication required");
  }
  if (!orgId) {
    return proxyFailure(trace, 403, "Active organization required");
  }
  if (!(await getSelectedProjectId())) {
    return proxyFailure(trace, 400, "Selected project required");
  }

  const requestInit =
    method === "GET" || method === "DELETE"
      ? { method }
      : {
          method,
          body: JSON.stringify(init?.body ?? {}),
          headers: { "content-type": "application/json" },
        };

  try {
    const apiClient = await createSdpApiClient(trace.childContext("api"));
    const response = await apiClient.request(`/v1/webhook-endpoints${apiPath}`, requestInit);
    const payload = await response.json().catch(() => ({}));
    return NextResponse.json(payload, {
      status: response.status,
      headers: {
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

// Allowlisted pagination passthrough — never forward the raw query string.
export function paginationQuery(request: Request): string {
  const url = new URL(request.url);
  const params = new URLSearchParams();
  const page = url.searchParams.get("page");
  const pageSize = url.searchParams.get("pageSize");
  if (page && /^\d{1,4}$/.test(page)) {
    params.set("page", page);
  }
  if (pageSize && /^\d{1,3}$/.test(pageSize)) {
    params.set("pageSize", pageSize);
  }
  const query = params.toString();
  return query ? `?${query}` : "";
}
