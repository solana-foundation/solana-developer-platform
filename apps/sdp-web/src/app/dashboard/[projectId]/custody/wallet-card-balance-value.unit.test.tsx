import type { CustodyWalletTokenBalance } from "@sdp/types";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SANDBOX_PROJECT } from "@/test/projects";
import { restoreWindowLocation, setWindowPathname } from "@/test/window-location";

const { mockUsePersistedDashboardSWR } = vi.hoisted(() => ({
  mockUsePersistedDashboardSWR: vi.fn(),
}));

vi.mock("@/i18n/provider", () => ({
  useTranslations: () => (key: string) => key,
}));

vi.mock("@/lib/dashboard-swr", () => ({
  usePersistedDashboardSWR: mockUsePersistedDashboardSWR,
}));

import { WalletCardBalanceValue } from "./wallet-card-balance-value";

const WALLET_ID = "wallet-1";

function balance(usdValue: number): CustodyWalletTokenBalance {
  return {
    token: "USDC",
    mint: "mint-1",
    amount: String(usdValue * 1_000_000),
    uiAmount: String(usdValue),
    decimals: 6,
    usdValue,
  };
}

function renderBalance(initialBalances: CustodyWalletTokenBalance[] = [balance(1)]): string {
  return renderToStaticMarkup(
    <WalletCardBalanceValue walletId={WALLET_ID} initialBalances={initialBalances} />
  );
}

beforeEach(() => {
  setWindowPathname(`/dashboard/${SANDBOX_PROJECT.id}/custody`);
});

afterEach(() => {
  mockUsePersistedDashboardSWR.mockReset();
  restoreWindowLocation();
  vi.unstubAllGlobals();
});

describe("WalletCardBalanceValue", () => {
  it("shows unavailable instead of zero when no successful balance read exists", () => {
    mockUsePersistedDashboardSWR
      .mockReturnValueOnce({ data: undefined, error: new Error("batch unavailable") })
      .mockReturnValueOnce({ data: undefined, error: new Error("wallet unavailable") });
    const markup = renderToStaticMarkup(
      <WalletCardBalanceValue walletId={WALLET_ID} initialBalances={undefined} />
    );
    expect(markup).toContain("DashboardCustody.unavailable");
    expect(markup).not.toContain("$0.00");
  });

  it("keeps balance snapshots separate for SDP wallets sharing a provider reference", async () => {
    mockUsePersistedDashboardSWR.mockReturnValue({ data: undefined });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          data: {
            wallets: [
              { id: "cwlt_a", walletId: "provider_shared", balances: [balance(3)] },
              { id: "cwlt_b", walletId: "provider_shared", balances: [balance(7)] },
            ],
          },
        })
      )
    );
    renderBalance();
    const fetchBatch = mockUsePersistedDashboardSWR.mock.calls[0]?.[1];
    expect(await fetchBatch()).toEqual({ cwlt_a: [balance(3)], cwlt_b: [balance(7)] });
  });

  it("excludes unavailable balances while preserving a known empty wallet", async () => {
    mockUsePersistedDashboardSWR.mockReturnValue({ data: undefined });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          data: { wallets: [{ id: WALLET_ID }, { id: "empty-wallet", balances: [] }] },
        })
      )
    );
    renderBalance();
    const fetchBatch = mockUsePersistedDashboardSWR.mock.calls[0]?.[1];
    expect(await fetchBatch()).toEqual({ "empty-wallet": [] });
  });

  it("recovers an omitted wallet through its own balance endpoint", () => {
    mockUsePersistedDashboardSWR
      .mockReturnValueOnce({ data: { "other-wallet": [] }, error: undefined })
      .mockReturnValueOnce({ data: [balance(10)], error: undefined });
    expect(renderBalance()).toContain("$10.00");
    expect(mockUsePersistedDashboardSWR.mock.calls[1]?.[0]).toBe(
      `wallet-card-balance-fallback:${WALLET_ID}`
    );
  });

  it("keeps the per-wallet fallback dormant when the shared batch succeeds", () => {
    mockUsePersistedDashboardSWR
      .mockReturnValueOnce({ data: { [WALLET_ID]: [balance(12)] }, error: undefined })
      .mockReturnValueOnce({ data: undefined, error: undefined });

    const markup = renderBalance();

    expect(mockUsePersistedDashboardSWR).toHaveBeenCalledTimes(2);
    expect(mockUsePersistedDashboardSWR.mock.calls[1]?.[0]).toBeNull();
    expect(markup).toContain("$12.00");
    expect(markup).not.toContain("DashboardCustody.stale");
  });

  it("loads only this wallet through the fallback when the shared batch fails", () => {
    mockUsePersistedDashboardSWR
      .mockReturnValueOnce({ data: undefined, error: new Error("batch unavailable") })
      .mockReturnValueOnce({ data: [balance(10)], error: undefined });

    const markup = renderBalance();

    expect(mockUsePersistedDashboardSWR.mock.calls[1]?.[0]).toBe(
      `wallet-card-balance-fallback:${WALLET_ID}`
    );
    expect(markup).toContain("$10.00");
    expect(markup).not.toContain("DashboardCustody.stale");
  });

  it("keeps stale data marked when both the shared batch and this wallet fail", () => {
    mockUsePersistedDashboardSWR
      .mockReturnValueOnce({
        data: { [WALLET_ID]: [balance(3)] },
        error: new Error("batch unavailable"),
      })
      .mockReturnValueOnce({ data: undefined, error: new Error("wallet unavailable") });

    const markup = renderBalance();

    expect(markup).toContain("$3.00");
    expect(markup).toContain("DashboardCustody.stale");
  });
});
