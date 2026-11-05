import {
  type DashboardKeyScope,
  type DashboardRequestKey,
  dashboardRequestKey,
  readsUnderPath,
} from "@/lib/dashboard-request-key";

const EARN_PATH = "/api/dashboard/markets/earn";

/**
 * The page size every paged Earn read asks for. The API caps `pageSize` and `limit` at 100, so a
 * full collection pages at this size; the paged readers request each page under one key.
 */
export const EARN_PAGE_SIZE = 100;

const readsEarn = readsUnderPath(EARN_PATH);
const readsEarnCatalogue = readsUnderPath(`${EARN_PATH}/strategies`);
const readsKaminoAllocations = readsUnderPath(`${EARN_PATH}/kamino-allocations`);
const readsEarnProviderAccess = readsUnderPath(`${EARN_PATH}/provider-access`);
const readsWallets = readsUnderPath("/api/dashboard/wallets");
const readsWalletBalances = readsUnderPath("/api/dashboard/payments/wallets");

function programPath(programId: string) {
  return `${EARN_PATH}/programs/${encodeURIComponent(programId)}` as const;
}

export const earnQueryKeys = {
  programs: (scope: DashboardKeyScope) =>
    dashboardRequestKey(scope, `${EARN_PATH}/programs`, { pageSize: EARN_PAGE_SIZE }),
  strategies: (scope: DashboardKeyScope, { cluster }: { cluster: string | undefined }) =>
    dashboardRequestKey(scope, `${EARN_PATH}/strategies`, { pageSize: EARN_PAGE_SIZE, cluster }),
  vaultPositions: (scope: DashboardKeyScope) =>
    dashboardRequestKey(scope, `${EARN_PATH}/vault-positions`, { limit: EARN_PAGE_SIZE }),
  externalWalletPositionSummary: (scope: DashboardKeyScope) =>
    dashboardRequestKey(scope, `${EARN_PATH}/external-wallet/positions/summary`),
  vaultDepositsInFlight: (scope: DashboardKeyScope) =>
    dashboardRequestKey(scope, `${EARN_PATH}/vault-deposits`, {
      limit: EARN_PAGE_SIZE,
      settled: false,
    }),
  vaultDeposit: (scope: DashboardKeyScope, { movementId }: { movementId: string }) =>
    dashboardRequestKey(scope, `${EARN_PATH}/vault-deposits/${encodeURIComponent(movementId)}`),
  vaultWithdrawalsInFlight: (scope: DashboardKeyScope) =>
    dashboardRequestKey(scope, `${EARN_PATH}/vault-withdrawals`, {
      limit: EARN_PAGE_SIZE,
      settled: false,
    }),
  vaultWithdrawal: (scope: DashboardKeyScope, { movementId }: { movementId: string }) =>
    dashboardRequestKey(scope, `${EARN_PATH}/vault-withdrawals/${encodeURIComponent(movementId)}`),
  vaultWithdrawalRequestsOpen: (scope: DashboardKeyScope) =>
    dashboardRequestKey(scope, `${EARN_PATH}/vault-withdrawal-requests`, {
      limit: EARN_PAGE_SIZE,
      settled: false,
    }),
  vaultWithdrawalRequest: (
    scope: DashboardKeyScope,
    { withdrawalRequestId }: { withdrawalRequestId: string }
  ) =>
    dashboardRequestKey(
      scope,
      `${EARN_PATH}/vault-withdrawal-requests/${encodeURIComponent(withdrawalRequestId)}`
    ),
  programWithdrawals: (scope: DashboardKeyScope, { programId }: { programId: string }) =>
    dashboardRequestKey(scope, `${programPath(programId)}/withdrawals`, {
      pageSize: EARN_PAGE_SIZE,
    }),
  withdrawal: (
    scope: DashboardKeyScope,
    { programId, withdrawalRef }: { programId: string; withdrawalRef: string }
  ) =>
    dashboardRequestKey(
      scope,
      `${programPath(programId)}/withdrawals/${encodeURIComponent(withdrawalRef)}`
    ),
  /** The label key the wallet module's invalidation still matches; superseded by `fundingWalletInventory`. */
  fundingWallets: () => "dashboard-earn-funding-wallets",
  /**
   * The funding-wallet inventory: the wallet list with balances, then live balance reads for any
   * wallet a confirmed movement touched. Its first request leaves out the `view=summary` the
   * shared wallet summaries send (the API serves both views alike), so the two reads, which cache
   * different shapes, never share an entry.
   */
  fundingWalletInventory: (scope: DashboardKeyScope) =>
    dashboardRequestKey(scope, "/api/dashboard/wallets", { includeBalances: "true" }),
  kaminoAllocations: (scope: DashboardKeyScope, { vaults }: { vaults: string }) =>
    dashboardRequestKey(scope, `${EARN_PATH}/kamino-allocations`, {
      vaults,
      cluster: "mainnet-beta",
    }),
  providerAccess: (scope: DashboardKeyScope) =>
    dashboardRequestKey(scope, `${EARN_PATH}/provider-access`),
  /**
   * Every read an Earn money write can change: the Earn ledgers, positions and programs, and the
   * wallet balances the money moves between. Not the strategy catalogue, the Kamino allocations or
   * provider access, which no movement changes.
   */
  isMoneyMovementRead: (key: DashboardRequestKey) =>
    (readsEarn(key) &&
      !readsEarnCatalogue(key) &&
      !readsKaminoAllocations(key) &&
      !readsEarnProviderAccess(key)) ||
    readsWallets(key) ||
    readsWalletBalances(key),
};
