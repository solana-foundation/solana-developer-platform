import { NextResponse } from "next/server";
import { createTimedTrace } from "@/lib/request-tracing";
import { createSdpApiClient } from "@/lib/sdp-api";

// Thin pass-through proxy from a Next route handler to an sdp-api issuance endpoint.
// Forwards Clerk auth + project scope via createSdpApiClient and relays the API's
// JSON envelope + status verbatim.
export async function proxyIssuance(
  request: Request,
  apiPath: string,
  init?: { method?: "GET" | "POST" | "PATCH" | "DELETE"; body?: unknown; traceName?: string }
): Promise<Response> {
  const method = init?.method ?? "GET";
  const trace = createTimedTrace(init?.traceName ?? `route.issuance.proxy.${method}`, request);
  const apiClient = await createSdpApiClient(trace.childContext("api"));

  const requestInit =
    method === "GET" || method === "DELETE"
      ? { method }
      : {
          method,
          body: JSON.stringify(init?.body ?? {}),
          headers: { "content-type": "application/json" },
        };

  const response = await apiClient.request(`/v1/issuance${apiPath}`, requestInit);
  const payload = await response.json().catch(() => ({}));
  return NextResponse.json(payload, { status: response.status });
}
