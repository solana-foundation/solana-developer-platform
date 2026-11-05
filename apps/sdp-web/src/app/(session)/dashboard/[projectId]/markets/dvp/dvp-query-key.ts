import {
  type DashboardKeyScope,
  type DashboardRequestKey,
  dashboardRequestKey,
  readsUnderPath,
} from "@/lib/dashboard-request-key";
import type { DvpTradesFilters } from "./dvp-trades.data";

const DVP_TRADES_PATH = "/api/dashboard/markets/dvp/trades";

const readsTrades = readsUnderPath(DVP_TRADES_PATH);
const readsWallets = readsUnderPath("/api/dashboard/wallets");
const readsWalletBalances = readsUnderPath("/api/dashboard/payments/wallets");

export const DVP_TRADES_PAGE_SIZE = 50;

/** The counterparty-account picker reads one page at the API's maximum, as the server page did. */
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
  createCounterpartyAccounts: (scope: DashboardKeyScope) =>
    dashboardRequestKey(scope, "/api/dashboard/counterparty/accounts", {
      pageSize: DVP_CREATE_OPTION_PAGE_SIZE,
    }),
  /** Every trade read: the list, the inbound list and each trade's record. */
  isTradeRead: readsTrades,
  /** What a trade action can change: every trade read, and the wallet balances tokens move between. */
  isTradeOrWalletRead: (key: DashboardRequestKey) =>
    readsTrades(key) || readsWallets(key) || readsWalletBalances(key),
};
