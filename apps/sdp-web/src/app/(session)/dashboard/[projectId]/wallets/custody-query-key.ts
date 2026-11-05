import type { Arguments } from "swr";
import { issuanceQueryKeys } from "@/app/(session)/dashboard/[projectId]/issuance/issuance-query-key";
import { earnQueryKeys } from "@/app/(session)/dashboard/[projectId]/markets/earn/earn-query-key";
import { paymentsQueryKeys } from "@/app/(session)/dashboard/[projectId]/payments/payments-query-key";
import {
  type DashboardKeyScope,
  type DashboardRequestKey,
  dashboardRequestKey,
  isDashboardRequestKey,
  readsUnderPath,
} from "@/lib/dashboard-request-key";
import { WALLET_ACTIVITY_LIMIT } from "./wallet-activity.data";

const readsWalletsPath = readsUnderPath("/api/dashboard/wallets");
const readsWalletBalancesPath = readsUnderPath("/api/dashboard/payments/wallets");

function walletPath(walletId: string) {
  return `/api/dashboard/wallets/${encodeURIComponent(walletId)}` as const;
}

export const custodyQueryKeys = {
  wallets: (scope: DashboardKeyScope) => dashboardRequestKey(scope, "/api/dashboard/wallets"),
  configs: (scope: DashboardKeyScope) =>
    dashboardRequestKey(scope, "/api/dashboard/wallets/configs"),
  wallet: (scope: DashboardKeyScope, { walletId }: { walletId: string }) =>
    dashboardRequestKey(scope, walletPath(walletId)),
  walletBalances: (scope: DashboardKeyScope, { walletId }: { walletId: string }) =>
    dashboardRequestKey(
      scope,
      `/api/dashboard/payments/wallets/${encodeURIComponent(walletId)}/balances`
    ),
  walletActivity: (
    scope: DashboardKeyScope,
    { walletId, limit }: { walletId: string; limit: number }
  ) =>
    dashboardRequestKey(scope, `${walletPath(walletId)}/activity`, {
      limit: limit === WALLET_ACTIVITY_LIMIT ? undefined : limit,
    }),
  /** Any wallet's record, balances or activity, the custody configs, and the wallet lists. */
  isWalletReadKey: (key: DashboardRequestKey) =>
    readsWalletsPath(key) || readsWalletBalancesPath(key),
  /** The wallet inventories other features read (payments, Earn, issuance pickers). */
  isWalletInventoryKey: (key: Arguments) =>
    (isDashboardRequestKey(key) && custodyQueryKeys.isWalletReadKey(key)) ||
    key === paymentsQueryKeys.actionWallets() ||
    key === earnQueryKeys.fundingWallets() ||
    issuanceQueryKeys.isWalletInventoryKey(key),
};
