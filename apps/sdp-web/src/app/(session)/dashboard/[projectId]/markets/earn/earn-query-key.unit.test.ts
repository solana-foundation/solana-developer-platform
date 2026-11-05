import { describe, expect, it } from "vitest";
import { dvpQueryKeys } from "@/app/(session)/dashboard/[projectId]/markets/dvp/dvp-query-key";
import { parseDvpTradesFilters } from "@/app/(session)/dashboard/[projectId]/markets/dvp/dvp-trades-query";
import { sharedReadQueryKeys } from "@/app/(session)/dashboard/[projectId]/payments/shared-reads-query-key";
import {
  type DashboardKeyScope,
  dashboardRequestKey,
  dashboardRequestUrl,
} from "@/lib/dashboard-request-key";
import { SANDBOX_PROJECT } from "@/test/projects";
import { earnQueryKeys } from "./earn-query-key";

const SCOPE: DashboardKeyScope = { projectId: SANDBOX_PROJECT.id, mode: "live" };

describe("earnQueryKeys", () => {
  it("encodes each record id into its own path", () => {
    expect(
      [
        earnQueryKeys.vaultDeposit(SCOPE, { movementId: "mov/1" }),
        earnQueryKeys.vaultWithdrawalRequest(SCOPE, { withdrawalRequestId: "req/1" }),
        earnQueryKeys.withdrawal(SCOPE, { programId: "prg/1", withdrawalRef: "wd/1" }),
      ].map(dashboardRequestUrl)
    ).toEqual([
      "/api/dashboard/markets/earn/vault-deposits/mov%2F1",
      "/api/dashboard/markets/earn/vault-withdrawal-requests/req%2F1",
      "/api/dashboard/markets/earn/programs/prg%2F1/withdrawals/wd%2F1",
    ]);
  });

  it("never shares a cache entry with the shared wallet summaries", () => {
    expect(dashboardRequestUrl(earnQueryKeys.fundingWalletInventory(SCOPE))).toBe(
      "/api/dashboard/wallets?includeBalances=true"
    );
    expect(
      dashboardRequestUrl(sharedReadQueryKeys.walletSummaries(SCOPE, { includeBalances: true }))
    ).toBe("/api/dashboard/wallets?includeBalances=true&view=summary");
  });
});

describe("earnQueryKeys.isMoneyMovementRead", () => {
  it.each([
    ["the programs", earnQueryKeys.programs(SCOPE)],
    ["the vault positions", earnQueryKeys.vaultPositions(SCOPE)],
    ["the external-wallet summary", earnQueryKeys.externalWalletPositionSummary(SCOPE)],
    ["the in-flight deposits", earnQueryKeys.vaultDepositsInFlight(SCOPE)],
    ["one deposit", earnQueryKeys.vaultDeposit(SCOPE, { movementId: "mov_test" })],
    ["the in-flight withdrawals", earnQueryKeys.vaultWithdrawalsInFlight(SCOPE)],
    ["the open queued requests", earnQueryKeys.vaultWithdrawalRequestsOpen(SCOPE)],
    ["a program's withdrawals", earnQueryKeys.programWithdrawals(SCOPE, { programId: "prg_test" })],
    ["the funding-wallet inventory", earnQueryKeys.fundingWalletInventory(SCOPE)],
    [
      "the shared wallet summaries",
      sharedReadQueryKeys.walletSummaries(SCOPE, { includeBalances: false }),
    ],
    [
      "a wallet's live balances",
      dashboardRequestKey(SCOPE, "/api/dashboard/payments/wallets/wal_test/balances"),
    ],
  ])("matches %s", (_read, key) => {
    expect(earnQueryKeys.isMoneyMovementRead(key)).toBe(true);
  });

  it.each([
    ["the strategy catalogue", earnQueryKeys.strategies(SCOPE, { cluster: "devnet" })],
    ["the Kamino allocations", earnQueryKeys.kaminoAllocations(SCOPE, { vaults: "Kvault_test" })],
    ["the DvP trades", dvpQueryKeys.trades(SCOPE, parseDvpTradesFilters({}).filters)],
    ["the provider access", sharedReadQueryKeys.organizationProviderAccess(SCOPE)],
  ])("leaves %s alone", (_read, key) => {
    expect(earnQueryKeys.isMoneyMovementRead(key)).toBe(false);
  });
});
