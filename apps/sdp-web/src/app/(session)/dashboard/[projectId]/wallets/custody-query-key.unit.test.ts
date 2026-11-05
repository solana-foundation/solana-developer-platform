import { describe, expect, it } from "vitest";
import { earnQueryKeys } from "@/app/(session)/dashboard/[projectId]/markets/earn/earn-query-key";
import { paymentsQueryKeys } from "@/app/(session)/dashboard/[projectId]/payments/payments-query-key";
import { sharedReadQueryKeys } from "@/app/(session)/dashboard/[projectId]/payments/shared-reads-query-key";
import { type DashboardKeyScope, dashboardRequestUrl } from "@/lib/dashboard-request-key";
import { SANDBOX_PROJECT } from "@/test/projects";
import { custodyQueryKeys } from "./custody-query-key";
import { WALLET_ACTIVITY_LIMIT } from "./wallet-activity.data";

const SCOPE: DashboardKeyScope = { projectId: SANDBOX_PROJECT.id, mode: "demo" };

describe("custody query keys", () => {
  it("keys each read by the request it sends", () => {
    expect([
      custodyQueryKeys.wallets(SCOPE),
      custodyQueryKeys.configs(SCOPE),
      custodyQueryKeys.wallet(SCOPE, { walletId: "wal_test/1" }),
      custodyQueryKeys.walletBalances(SCOPE, { walletId: "wal_test/1" }),
    ]).toEqual([
      [SANDBOX_PROJECT.id, "demo", "/api/dashboard/wallets"],
      [SANDBOX_PROJECT.id, "demo", "/api/dashboard/wallets/configs"],
      [SANDBOX_PROJECT.id, "demo", "/api/dashboard/wallets/wal_test%2F1"],
      [SANDBOX_PROJECT.id, "demo", "/api/dashboard/payments/wallets/wal_test%2F1/balances"],
    ]);
  });

  it("asks for an activity limit only when it differs from the default window", () => {
    expect(
      [WALLET_ACTIVITY_LIMIT, 120].map((limit) =>
        dashboardRequestUrl(
          custodyQueryKeys.walletActivity(SCOPE, { walletId: "wal_test_1", limit })
        )
      )
    ).toEqual([
      "/api/dashboard/wallets/wal_test_1/activity",
      "/api/dashboard/wallets/wal_test_1/activity?limit=120",
    ]);
  });

  it("matches every wallet read and inventory, and nothing else", () => {
    const matches = [
      custodyQueryKeys.wallets(SCOPE),
      custodyQueryKeys.configs(SCOPE),
      custodyQueryKeys.wallet(SCOPE, { walletId: "wal_test_1" }),
      custodyQueryKeys.walletBalances(SCOPE, { walletId: "wal_test_1" }),
      custodyQueryKeys.walletActivity(SCOPE, { walletId: "wal_test_1", limit: 120 }),
      sharedReadQueryKeys.walletSummaries(SCOPE, { includeBalances: true }),
      sharedReadQueryKeys.walletAggregate(SCOPE),
      paymentsQueryKeys.actionWallets(),
      earnQueryKeys.fundingWallets(),
    ];
    const nonMatches = [
      sharedReadQueryKeys.counterparties(SCOPE, { page: 1, pageSize: 20 }),
      sharedReadQueryKeys.issuedTokens(SCOPE, { pageSize: 100 }),
      "payments-action-counterparties",
      [
        SANDBOX_PROJECT.id,
        "live",
        "/api/dashboard/payments/transfers",
        { custodyWalletId: "wal_test_1" },
      ],
    ];
    expect(matches.map(custodyQueryKeys.isWalletInventoryKey)).toEqual(matches.map(() => true));
    expect(nonMatches.map(custodyQueryKeys.isWalletInventoryKey)).toEqual(
      nonMatches.map(() => false)
    );
  });
});
