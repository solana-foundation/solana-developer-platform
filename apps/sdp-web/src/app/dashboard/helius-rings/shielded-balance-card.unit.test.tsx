// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import type { RingsWallet, RingsWalletSync } from "./helius-rings.data";
import { ShieldedBalanceCard } from "./shielded-balance-card";

const mocks = vi.hoisted(() => ({ syncRingsWallet: vi.fn() }));

vi.mock("./helius-rings.data", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./helius-rings.data")>()),
  syncRingsWallet: mocks.syncRingsWallet,
}));

const WALLET: RingsWallet = {
  id: "hrw_treasury",
  sdpWalletId: "wal_treasury",
  name: "Treasury",
  shieldedAddress: "rings1treasury",
  status: "ready",
  network: "devnet",
};

const OBSERVED: RingsWalletSync = {
  balances: [
    {
      mint: "So11111111111111111111111111111111111111112",
      symbol: "SOL",
      amountRaw: "1000000000",
      decimals: 9,
      usdPrice: 150,
      usdValue: 150,
    },
  ],
  degraded: false,
  observedAt: "2026-08-26T12:00:00.000Z",
  totalUsd: 150,
};

function renderCard(wallet: RingsWallet = WALLET, refreshTick?: number) {
  return render(
    <I18nProvider locale="en" messages={getMessages("en")}>
      <ShieldedBalanceCard wallet={wallet} refreshTick={refreshTick} />
    </I18nProvider>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(cleanup);

describe("ShieldedBalanceCard", () => {
  it("auto-syncs on mount and shows the USD total", async () => {
    mocks.syncRingsWallet.mockResolvedValue({ sync: OBSERVED });
    renderCard();

    expect(await screen.findByText("$150.00")).toBeTruthy();
    expect(mocks.syncRingsWallet).toHaveBeenCalledWith(WALLET.id);
  });

  it("renders 0 for an observed empty wallet, distinct from a not-yet-read one", async () => {
    mocks.syncRingsWallet.mockResolvedValue({
      sync: { balances: [], degraded: false, observedAt: OBSERVED.observedAt, totalUsd: 0 },
    });
    renderCard();

    expect(await screen.findByText("0")).toBeTruthy();
    expect(screen.queryByText(/Not read yet/)).toBeNull();
  });

  it("surfaces the server's own reason when the read fails", async () => {
    mocks.syncRingsWallet.mockResolvedValue({
      error: "rings wallet has no shielded identity yet; provision it before syncing",
    });
    renderCard();

    expect(await screen.findByText(/provision it before syncing/)).toBeTruthy();
  });

  it("falls back to its own copy when the failure carried no message", async () => {
    mocks.syncRingsWallet.mockResolvedValue({});
    renderCard();

    expect(await screen.findByText(/could not be read/)).toBeTruthy();
  });

  it("survives a rejected fetch by rendering the failed copy", async () => {
    mocks.syncRingsWallet.mockRejectedValue(new TypeError("Failed to fetch"));
    renderCard();

    expect(await screen.findByText(/could not be read/)).toBeTruthy();
  });

  it("skips the read entirely for a wallet with no shielded identity", () => {
    renderCard({ ...WALLET, shieldedAddress: null, status: "pending" });

    expect(mocks.syncRingsWallet).not.toHaveBeenCalled();
    // Reason is text (not a tooltip on a disabled button) so it reaches screen readers.
    expect(screen.getByText(/no shielded identity yet/)).toBeTruthy();
  });

  it("falls back to the unpriced marker when totalUsd is absent", async () => {
    mocks.syncRingsWallet.mockResolvedValue({
      sync: { ...OBSERVED, totalUsd: null },
    });
    renderCard();

    expect(await screen.findByText("—")).toBeTruthy();
  });
});
