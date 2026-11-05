import {
  type DashboardKeyScope,
  dashboardRequestKey,
  readsUnderPath,
} from "@/lib/dashboard-request-key";

export const organizationQueryKeys = {
  current: (scope: DashboardKeyScope) =>
    dashboardRequestKey(scope, "/api/dashboard/organizations/current"),
  mainnetAccess: (scope: DashboardKeyScope, { organizationId }: { organizationId: string }) =>
    dashboardRequestKey(
      scope,
      `/api/dashboard/organizations/${encodeURIComponent(organizationId)}/mainnet-access`
    ),
};

export const organizationReads = readsUnderPath("/api/dashboard/organizations");
