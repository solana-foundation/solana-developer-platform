// @vitest-environment jsdom

import { WELL_KNOWN_TOKENS } from "@sdp/types/well-known-tokens";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EnglishI18n } from "@/test/i18n";
import { WalletsTable } from "./wallets-table";

vi.mock("next/navigation", () => import("@/test/next-navigation"));
vi.mock("./actions", () => ({
  deleteVerifiedWalletAction: vi.fn(),
  verifyWalletAction: vi.fn(),
}));

const OWNER_A = "OwnerA111111111111111111111111111111111111";
const OWNER_B = "OwnerB111111111111111111111111111111111111";

afterEach(() => {
  cleanup();
});

describe("WalletsTable", () => {
  it("shows a dash for a wallet whose channel balance did not load", () => {
    render(
      <WalletsTable
        verifiedWallets={[
          {
            id: "pcvw_test_a",
            walletId: "wallet_test_a",
            pubkey: OWNER_A,
            verifiedAt: "2026-09-16",
          },
          {
            id: "pcvw_test_b",
            walletId: "wallet_test_b",
            pubkey: OWNER_B,
            verifiedAt: "2026-09-16",
          },
        ]}
        custodyWallets={[]}
        channelBalances={{
          [OWNER_A]: {
            mint: WELL_KNOWN_TOKENS.USDC.mints.devnet.address,
            amount: "12500000",
            decimals: 6,
            uiAmount: "12.5",
          },
        }}
        loadError={false}
        canWrite={false}
      />,
      { wrapper: EnglishI18n }
    );

    const [, loadedRow, failedRow] = screen.getAllByRole("row");
    if (loadedRow === undefined || failedRow === undefined) throw new Error("Missing wallet rows");
    expect(within(loadedRow).getByText("12.5 USDC")).toBeTruthy();
    expect(within(failedRow).getByText("—")).toBeTruthy();
  });
});
