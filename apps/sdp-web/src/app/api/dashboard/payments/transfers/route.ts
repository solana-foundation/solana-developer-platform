import { fetchDashboardPaymentTransfers } from "@/app/(session)/dashboard/[projectId]/payments/payments-page.data";
import { dashboardJson } from "@/lib/dashboard-response";
import { createTimedTrace, logRouteResult } from "@/lib/request-tracing";
import {
  createSdpApiClient,
  proxyToSdpApi,
  rejectUnscopedDashboardRequest,
  unexpectedRouteFailure,
} from "@/lib/sdp-api";

/**
 * Not a pure proxy: without a direct filter this aggregates transfers via
 * fetchDashboardPaymentTransfers, so that branch builds its own client.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const hasDirectTransferFilter = [
    "custodyWalletId",
    "wallet",
    "walletAddress",
    "provider",
    "providerReference",
    "category",
    "counterpartyId",
  ].some((param) => url.searchParams.has(param));

  if (hasDirectTransferFilter) {
    return proxyToSdpApi({
      request,
      traceSource: "route.dashboard.payments.transfers.get",
      path: `/v1/payments/transfers${url.search}`,
    });
  }

  const trace = createTimedTrace("route.dashboard.payments.transfers.get", request);

  const rejection = await rejectUnscopedDashboardRequest(request, trace);
  if (rejection) {
    return rejection;
  }

  try {
    const apiClient = await createSdpApiClient(
      trace.childContext("route.dashboard.payments.transfers.api")
    );
    const pageSize = Number.parseInt(url.searchParams.get("pageSize") ?? "20", 10);
    const result = await fetchDashboardPaymentTransfers(
      apiClient.request,
      Number.isFinite(pageSize) && pageSize > 0 ? pageSize : 20
    );
    const status = result.ok ? 200 : (result.status ?? 500);
    const nextResponse = dashboardJson(
      result.ok
        ? { data: result.data ?? [] }
        : { error: { message: result.error ?? "Transfer list request failed" } },
      {
        status,
        trace,
      }
    );

    logRouteResult(trace, status, {
      query: url.searchParams.toString(),
      source: "dashboard_aggregate",
    });

    return nextResponse;
  } catch (error) {
    return unexpectedRouteFailure(trace, error, "Transfer list request failed");
  }
}

export async function POST(request: Request) {
  return proxyToSdpApi({
    request,
    traceSource: "route.dashboard.payments.transfers.post",
    path: "/v1/payments/transfers",
  });
}
