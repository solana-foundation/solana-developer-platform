import { type DashboardKeyScope, dashboardRequestKey } from "@/lib/dashboard-request-key";

/** Reads every module shares. Only `shared-reads.ts` builds requests from these keys. */
export const sharedReadQueryKeys = {
  walletSummaries: (scope: DashboardKeyScope, options: { includeBalances: boolean }) =>
    dashboardRequestKey(scope, "/api/dashboard/wallets", {
      view: "summary",
      includeBalances: options.includeBalances ? "true" : undefined,
    }),
  walletAggregate: (scope: DashboardKeyScope) =>
    dashboardRequestKey(scope, "/api/dashboard/wallets/aggregate"),
  counterparties: (scope: DashboardKeyScope, options: { page: number; pageSize: number }) =>
    dashboardRequestKey(scope, "/api/dashboard/counterparty", options),
  organizationProviderAccess: (scope: DashboardKeyScope) =>
    dashboardRequestKey(scope, "/api/dashboard/organizations/current/provider-access"),
  privateChannelInstance: (scope: DashboardKeyScope) =>
    dashboardRequestKey(scope, "/api/dashboard/private-channels/instance"),
  apiKey: (scope: DashboardKeyScope, options: { keyId: string }) =>
    dashboardRequestKey(scope, `/api/dashboard/api-keys/${encodeURIComponent(options.keyId)}`),
  issuedTokens: (scope: DashboardKeyScope, options: { pageSize: number }) =>
    dashboardRequestKey(scope, "/api/dashboard/issuance/tokens", options),
};
