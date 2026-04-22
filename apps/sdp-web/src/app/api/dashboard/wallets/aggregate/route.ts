import { NextResponse } from "next/server";
import { createTimedTrace, logRouteResult } from "@/lib/request-tracing";
import { createSdpApiClient } from "@/lib/sdp-api";

export async function GET(request: Request) {
  const trace = createTimedTrace("route.dashboard.wallets.aggregate", request);

  try {
    const apiClient = await createSdpApiClient(
      trace.childContext("route.dashboard.wallets.aggregate.api")
    );
    const url = new URL(request.url);
    const query = new URLSearchParams(url.searchParams);

    // biome-ignore lint/security/noSecrets: Query parameter name, not a secret.
    if (!query.has("includeAllProviders")) {
      // biome-ignore lint/security/noSecrets: Query parameter name, not a secret.
      query.set("includeAllProviders", "true");
    }

    const response = await apiClient.request(`/v1/wallets/aggregate?${query.toString()}`);
    const body = await response.text();
    const contentType = response.headers.get("Content-Type") ?? "application/json";

    const nextResponse = new NextResponse(body, {
      status: response.status,
      headers: {
        "Content-Type": contentType,
        "X-SDP-Trace-ID": trace.traceId,
        "Server-Timing": trace.serverTiming(),
      },
    });

    logRouteResult(trace, response.status, {
      query: query.toString(),
    });

    return nextResponse;
  } catch (error) {
    const response = NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Failed to fetch aggregate wallet balances",
      },
      {
        status: 500,
        headers: {
          "X-SDP-Trace-ID": trace.traceId,
          "Server-Timing": trace.serverTiming(),
        },
      }
    );
    logRouteResult(trace, 500, {
      error: error instanceof Error ? error.message : "Failed to fetch aggregate wallet balances",
    });
    return response;
  }
}
