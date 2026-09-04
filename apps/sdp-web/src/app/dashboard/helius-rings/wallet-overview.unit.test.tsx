// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import type { ProjectRing, RingsWallet, RingsWalletSync } from "./helius-rings.data";
import { WalletOverview } from "./wallet-overview";

const mocks = vi.hoisted(() => ({ syncRingsWallet: vi.fn() }));

vi.mock("./helius-rings.data", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./helius-rings.data")>()),
  syncRingsWallet: mocks.syncRingsWallet,
}));

const SOL = "So11111111111111111111111111111111111111112";
const TREASURY_RING = "RingProgram1111111111111111111111111111111";
const PAYROLL_RING = "RingProgram2111111111111111111111111111111";

const WALLET: RingsWallet = {
  id: "hrw_treasury",
  sdpWalletId: "wal_treasury",
  name: "Treasury",
  shieldedAddress: "rings1treasury",
  status: "ready",
  network: "devnet",
};

const RINGS: ProjectRing[] = [
  {
    id: "hrr_1",
    name: "treasury",
    ringProgramId: TREASURY_RING,
    status: "active",
    auditorPublicKeyHex: "04ff",
    lookupTableAddress: "LookupTab1e11111111111111111111111111111111",
    failure: null,
    createdAt: "2026-08-26T12:00:00.000Z",
    updatedAt: "2026-08-26T12:00:00.000Z",
  },
];

function balance(ringProgramId: string | null, amountRaw: string, usdValue?: number) {
  return { mint: SOL, symbol: "SOL", amountRaw, decimals: 9, ringProgramId, usdValue };
}

function sync(balances: RingsWalletSync["balances"], totalUsd?: number | null): RingsWalletSync {
  return { balances, degraded: false, observedAt: "2026-08-26T12:00:00.000Z", totalUsd };
}

function renderOverview(projectRings: ProjectRing[] = [], wallet: RingsWallet = WALLET) {
  return render(
    <I18nProvider locale="en" messages={getMessages("en")}>
      <WalletOverview wallet={wallet} projectRings={projectRings} />
    </I18nProvider>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(cleanup);

describe("WalletOverview", () => {
  it("reads the balance on mount and shows the USD total", async () => {
    mocks.syncRingsWallet.mockResolvedValue({
      sync: sync([balance(null, "1000000000", 150), balance(null, "500000000", 75)], 225),
    });
    renderOverview();

    // The total is its own line above the per-mint rows.
    expect(await screen.findByText("$225.00")).toBeTruthy();
    expect(screen.getByText("$150.00")).toBeTruthy();
    expect(mocks.syncRingsWallet).toHaveBeenCalledExactlyOnceWith("hrw_treasury");
  });

  it("names each ring group by its recorded name and falls back to a truncated id", async () => {
    mocks.syncRingsWallet.mockResolvedValue({
      sync: sync(
        [
          balance(null, "1000000000", 150),
          balance(TREASURY_RING, "2000000000", 300),
          balance(PAYROLL_RING, "3000000000", 450),
        ],
        900
      ),
    });
    renderOverview(RINGS);

    expect(await screen.findByText("Default ring")).toBeTruthy();
    expect(screen.getByText("treasury")).toBeTruthy();
    // payroll's program is not among the project's recorded rings, so the group
    // keeps the truncated id rather than inventing a name for it.
    expect(screen.getByText(/Custom ring RingP/)).toBeTruthy();
  });

  // A single group needs no heading: the amount is already unambiguous.
  it("labels nothing when every note sits in one ring", async () => {
    mocks.syncRingsWallet.mockResolvedValue({
      sync: sync([balance(TREASURY_RING, "2000000000", 300)], 425),
    });
    renderOverview(RINGS);

    expect(await screen.findByText("$425.00")).toBeTruthy();
    expect(screen.queryByText("treasury")).toBeNull();
    expect(screen.queryByText("Default ring")).toBeNull();
  });

  it("shows an unpriced mint as a dash rather than zero dollars", async () => {
    mocks.syncRingsWallet.mockResolvedValue({ sync: sync([balance(null, "1000000000")], null) });
    renderOverview();

    expect(await screen.findByText("—")).toBeTruthy();
  });

  it("reads an empty balance as zero", async () => {
    mocks.syncRingsWallet.mockResolvedValue({ sync: sync([], 0) });
    renderOverview();

    expect(await screen.findByText("$0.00")).toBeTruthy();
  });

  it("says the read failed instead of presenting a missing balance as zero", async () => {
    mocks.syncRingsWallet.mockResolvedValue({ error: "the indexer is unavailable" });
    renderOverview();

    expect(await screen.findByText(/Balance could not be read/)).toBeTruthy();
  });

  it("re-reads on demand from the refresh control", async () => {
    mocks.syncRingsWallet.mockResolvedValue({
      sync: sync([balance(null, "1000000000", 150)], 225),
    });
    renderOverview();
    await screen.findByText("$225.00");

    // The control only names itself "Refresh" once a read has landed; while one
    // is in flight it reads "Reading…" and is disabled.
    await userEvent.setup().click(screen.getByRole("button", { name: "Refresh" }));

    expect(mocks.syncRingsWallet).toHaveBeenCalledTimes(2);
  });

  it("reads nothing, and cannot be refreshed, while the wallet has no shielded identity", () => {
    renderOverview(RINGS, { ...WALLET, shieldedAddress: null, status: "pending" });

    expect(screen.getByText("Not provisioned yet.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Reading…" }) as HTMLButtonElement).disabled).toBe(
      true
    );
    expect(mocks.syncRingsWallet).not.toHaveBeenCalled();
  });
});
