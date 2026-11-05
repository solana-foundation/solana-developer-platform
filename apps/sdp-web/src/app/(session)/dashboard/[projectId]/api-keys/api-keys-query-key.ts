import {
  type DashboardKeyScope,
  dashboardRequestKey,
  readsUnderPath,
} from "@/lib/dashboard-request-key";

export const apiKeysQueryKeys = {
  list: (scope: DashboardKeyScope) => dashboardRequestKey(scope, "/api/dashboard/api-keys"),
};

export const apiKeyReads = readsUnderPath("/api/dashboard/api-keys");
