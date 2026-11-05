import { type DashboardKeyScope, dashboardRequestKey } from "@/lib/dashboard-request-key";

export const homeQueryKeys = {
  activity: (scope: DashboardKeyScope) =>
    dashboardRequestKey(scope, "/api/dashboard/home/activity"),
  network: (scope: DashboardKeyScope) => dashboardRequestKey(scope, "/api/dashboard/network"),
};
