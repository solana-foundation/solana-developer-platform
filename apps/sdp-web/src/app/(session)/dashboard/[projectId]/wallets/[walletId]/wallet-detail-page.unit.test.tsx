import { isValidElement } from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@clerk/nextjs/server", () => ({ auth: vi.fn(async () => ({ orgId: "org_test" })) }));
vi.mock("next/navigation", () => import("@/test/next-navigation"));
vi.mock("@/flags", () => ({ issuance: vi.fn(async () => true) }));

import { WalletDetailPage } from "./wallet-detail-page";
import { WalletDetailView } from "./wallet-detail-view";

describe("WalletDetailPage", () => {
  it("hands the view the wallet id from the address, decoded, and the Issuance flag", async () => {
    const page = await WalletDetailPage({
      params: Promise.resolve({ walletId: "wal_test%2Fone" }),
    });

    if (!isValidElement(page)) throw new Error("the page rendered no element");
    expect(page.type).toBe(WalletDetailView);
    expect(page.props).toEqual({ walletId: "wal_test/one", issuanceEnabled: true });
  });
});
