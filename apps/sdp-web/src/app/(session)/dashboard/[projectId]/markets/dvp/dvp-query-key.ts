import {
  type DashboardKeyScope,
  dashboardRequestKey,
  readsUnderPath,
} from "@/lib/dashboard-request-key";
import type { DvpTradesFilters } from "./dvp-trades.data";

const DVP_TRADES_PATH = "/api/dashboard/markets/dvp/trades";

export const DVP_TRADES_PAGE_SIZE = 50;

/** The create form's pickers read one page at the API's maximum, as the server page did. */
export const DVP_CREATE_OPTION_PAGE_SIZE = 100;

function joinedOrAbsent(values: readonly string[] | null): string | undefined {
  // An empty group is the absence of the param: the API rejects an empty `status=`.
  return values === null || values.length === 0 ? undefined : values.join(",");
}

export const dvpQueryKeys = {
  trades: (scope: DashboardKeyScope, filters: DvpTradesFilters) =>
    dashboardRequestKey(scope, DVP_TRADES_PATH, {
      limit: DVP_TRADES_PAGE_SIZE,
      status: joinedOrAbsent(filters.statuses),
      settlementAvailability: joinedOrAbsent(filters.settlementAvailability),
      q: filters.q === null ? undefined : filters.q,
    }),
  inboundTrades: (scope: DashboardKeyScope) =>
    dashboardRequestKey(scope, `${DVP_TRADES_PATH}/inbound`),
  trade: (scope: DashboardKeyScope, { tradeId }: { tradeId: string }) =>
    dashboardRequestKey(scope, `${DVP_TRADES_PATH}/${encodeURIComponent(tradeId)}`),
  createTokens: (scope: DashboardKeyScope) =>
    dashboardRequestKey(scope, "/api/dashboard/issuance/tokens", {
      page: 1,
      pageSize: DVP_CREATE_OPTION_PAGE_SIZE,
    }),
  createCounterpartyAccounts: (scope: DashboardKeyScope) =>
    dashboardRequestKey(scope, "/api/dashboard/counterparty/accounts", {
      pageSize: DVP_CREATE_OPTION_PAGE_SIZE,
    }),
  /** Every trade read: the list, the inbound list and each trade's record. */
  isTradeRead: readsUnderPath(DVP_TRADES_PATH),
};
