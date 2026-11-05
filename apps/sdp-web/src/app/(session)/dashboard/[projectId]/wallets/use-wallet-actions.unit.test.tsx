// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  faucet: vi.fn(),
  refreshWalletInventory: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { loading: vi.fn(), success: vi.fn(), error: vi.fn() }),
}));
vi.mock("./use-wallet-inventory-refresh", () => ({
  useWalletInventoryRefresh: () => mocks.refreshWalletInventory,
}));
vi.mock("@/i18n/provider", () => ({ useTranslations: () => (key: string) => key }));
vi.mock("@/contexts/dashboard-workspace-context", () => ({
  useDashboardWorkspace: () => ({
    dashboardAccess: { capabilities: { canUseWalletSignerCheck: true } },
    sandboxProject: { id: "prj_sandbox" },
  }),
}));
vi.mock("@/app/(session)/dashboard/[projectId]/wallets/actions", () => ({
  checkWalletSignerMemoAction: vi.fn(),
  requestDevnetSolanaFaucetAction: mocks.faucet,
}));

const { useWalletActions } = await import("./use-wallet-actions");

beforeEach(() => {
  vi.clearAllMocks();
});

describe("useWalletActions", () => {
  it("refreshes the wallet reads once the faucet has funded the wallet", async () => {
    mocks.faucet.mockResolvedValue({ status: "success", signature: "sig", amountSol: "1" });
    const { result } = renderHook(() => useWalletActions({ walletId: "wallet_one" }));

    await act(async () => {
      result.current.requestDevnetSol();
    });

    expect(mocks.refreshWalletInventory).toHaveBeenCalledTimes(1);
  });

  it("leaves the wallet reads alone when the faucet refuses", async () => {
    mocks.faucet.mockResolvedValue({ status: "error", message: "Rate limited" });
    const { result } = renderHook(() => useWalletActions({ walletId: "wallet_one" }));

    await act(async () => {
      result.current.requestDevnetSol();
    });

    expect(mocks.refreshWalletInventory).not.toHaveBeenCalled();
  });
});
