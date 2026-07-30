import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { createTimedTrace } from "@/lib/request-tracing";
import { createOrgSdpApiClient, proxyFailure } from "@/lib/sdp-api";

// Pass-through proxy from a Next route handler to an sdp-api notifications endpoint.
// `apiPath` may include a query string (e.g. "?page=1&unread=true").
//
// Org-scoped, not project-scoped: /v1/notifications has no project middleware, so this
// uses `createOrgSdpApiClient`. The project-scoped client would throw whenever no project
// cookie is set — which the notification bell renders on every dashboard page, including
// before a project is ever selected.
export async function proxyNotifications(
  request: Request,
  apiPath: string,
  init?: { method?: "GET" | "POST"; body?: unknown; traceName?: string }
): Promise<Response> {
  const method = init?.method ?? "GET";
  const trace = createTimedTrace(init?.traceName ?? `route.notifications.proxy.${method}`, request);

  const { userId, orgId } = await auth();
  if (!userId) {
    return proxyFailure(trace, 401, "Authentication required");
  }
  if (!orgId) {
    return proxyFailure(trace, 403, "Active organization required");
  }

  const requestInit =
    method === "GET"
      ? { method }
      : {
          method,
          body: JSON.stringify(init?.body ?? {}),
          headers: { "content-type": "application/json" },
        };

  try {
    const apiClient = await createOrgSdpApiClient(trace.childContext("api"));
    const response = await apiClient.request(`/v1/notifications${apiPath}`, requestInit);
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
