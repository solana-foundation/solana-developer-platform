import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { createTimedTrace } from "@/lib/request-tracing";
import { createSdpApiClient, getSelectedProjectId, proxyFailure } from "@/lib/sdp-api";

// Pass-through proxy from a Next route handler to an sdp-api issuance endpoint.
//
// The auth pre-check mirrors `proxyToSdpApi`: without it, `createSdpApiClient` throws on
// a signed-out or org-less caller and Next renders an opaque 500, so the client can't
// tell "sign in again" from "the API is down". Trace headers go out on every response for
// the same reason every other dashboard route emits them.
export async function proxyIssuance(
  request: Request,
  apiPath: string,
  init?: { method?: "GET" | "POST" | "PATCH" | "DELETE"; body?: unknown; traceName?: string }
): Promise<Response> {
  const method = init?.method ?? "GET";
  const trace = createTimedTrace(init?.traceName ?? `route.issuance.proxy.${method}`, request);

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
    const response = await apiClient.request(`/v1/issuance${apiPath}`, requestInit);
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
