import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  newDesignOn: vi.fn(async () => false),
  redirect: vi.fn((_href: string) => {
    throw new Error("NEXT_REDIRECT");
  }),
}));

vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("@clerk/nextjs/server", () => ({ auth: vi.fn() }));
vi.mock("@/lib/auth-entry", () => ({ getAuthEntryPath: async () => "/sign-in" }));
vi.mock("@/lib/dashboard-page-trace", () => ({ withDashboardPageTrace: vi.fn() }));
vi.mock("../../payments-page.data", () => ({ fetchIssuedTokensByMint: vi.fn() }));
vi.mock("../transaction-detail.data", () => ({ fetchTransactionDetail: vi.fn() }));
vi.mock("../transaction-detail-workspace", () => ({ TransactionDetailWorkspace: () => null }));
vi.mock("@/flags/new-design", () => ({
  withLegacyDesign:
    <P extends object>(
      current: (props: P) => unknown,
      legacy: (props: P) => unknown,
      _designModule?: string
    ) =>
    async (props: P) =>
      (await mocks.newDesignOn()) ? current(props) : legacy(props),
}));

import TransactionDetailPage from "./page";

describe("transaction page with new-design-activity off", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("lands on the previous design's list searched for the transaction", async () => {
    // That list opens a transaction from a row only; the search narrows it to this one.
    await expect(
      TransactionDetailPage({ params: Promise.resolve({ transactionId: "txn_1/a b" }) })
    ).rejects.toThrow("NEXT_REDIRECT");

    expect(mocks.redirect).toHaveBeenCalledWith(
      "/dashboard/payments/transactions?search=txn_1%2Fa+b"
    );
  });
});
