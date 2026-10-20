// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  faucet: vi.fn(),
  mutate: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { loading: vi.fn(), success: vi.fn(), error: vi.fn() }),
}));
vi.mock("swr", () => ({ useSWRConfig: () => ({ mutate: mocks.mutate }) }));
vi.mock("@/i18n/provider", () => ({ useTranslations: () => (key: string) => key }));
vi.mock("@/contexts/dashboard-workspace-context", () => ({
  useDashboardWorkspace: () => ({
    dashboardAccess: { capabilities: { canUseWalletSignerCheck: true } },
    sandboxProject: { id: "prj_sandbox" },
  }),
}));
vi.mock("@/app/dashboard/[projectId]/custody/actions", () => ({
  checkWalletSignerMemoAction: vi.fn(),
  requestDevnetSolanaFaucetAction: mocks.faucet,
}));

const { useWalletActions } = await import("./use-wallet-actions");
const { custodyQueryKeys } = await import("./custody-query-key");

beforeEach(() => {
  vi.clearAllMocks();
});

describe("useWalletActions", () => {
  it("refreshes the cached wallet balances once the faucet has funded the wallet", async () => {
    mocks.faucet.mockResolvedValue({ status: "success", signature: "sig", amountSol: "1" });
    const { result } = renderHook(() => useWalletActions({ walletId: "wallet_one" }));

    await act(async () => {
      result.current.requestDevnetSol();
    });

    expect(mocks.mutate).toHaveBeenCalledWith(custodyQueryKeys.isWalletLiveDataKey);
  });

  it("leaves the cached balances alone when the faucet refuses", async () => {
    mocks.faucet.mockResolvedValue({ status: "error", message: "Rate limited" });
    const { result } = renderHook(() => useWalletActions({ walletId: "wallet_one" }));

    await act(async () => {
      result.current.requestDevnetSol();
    });

    expect(mocks.mutate).not.toHaveBeenCalled();
  });
});
