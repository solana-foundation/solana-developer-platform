import { loadEarnProviderAccess } from "@/app/(session)/dashboard/[projectId]/markets/earn/earn-provider-access.server";
import { dashboardJson } from "@/lib/dashboard-response";
import { createTimedTrace, logRouteResult } from "@/lib/request-tracing";

/**
 * This organization's Earn provider access, as the Earn pages rendered it on the server: the
 * onboarding status, then the organization's provider availability. Null whenever either cannot be
 * read, and null disables every deposit action.
 */
export async function GET(request: Request) {
  const trace = createTimedTrace("route.dashboard.markets.earn.provider-access", request);
  const providerAccess = await trace.step("load_earn_provider_access", () =>
    loadEarnProviderAccess()
  );
  const response = dashboardJson({ data: { providerAccess } }, { trace });
  logRouteResult(trace, 200, { known: providerAccess !== null });
  return response;
}
