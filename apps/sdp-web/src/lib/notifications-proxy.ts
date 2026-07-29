import { NextResponse } from "next/server";
import { createTimedTrace } from "@/lib/request-tracing";
import { createSdpApiClient } from "@/lib/sdp-api";

// Thin pass-through proxy from a Next route handler to an sdp-api notifications endpoint.
// Forwards Clerk auth via createSdpApiClient and relays the API's JSON envelope + status.
// `apiPath` may include a query string (e.g. "?page=1&unread=true").
export async function proxyNotifications(
  request: Request,
  apiPath: string,
  init?: { method?: "GET" | "POST"; body?: unknown; traceName?: string }
): Promise<Response> {
  const method = init?.method ?? "GET";
  const trace = createTimedTrace(init?.traceName ?? `route.notifications.proxy.${method}`, request);
  const apiClient = await createSdpApiClient(trace.childContext("api"));

  const requestInit =
    method === "GET"
      ? { method }
      : {
          method,
          body: JSON.stringify(init?.body ?? {}),
          headers: { "content-type": "application/json" },
        };

  const response = await apiClient.request(`/v1/notifications${apiPath}`, requestInit);
  const payload = await response.json().catch(() => ({}));
  return NextResponse.json(payload, { status: response.status });
}
