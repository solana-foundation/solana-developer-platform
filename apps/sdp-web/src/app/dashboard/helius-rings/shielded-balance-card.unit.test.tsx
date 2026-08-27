// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
      // 2^64 - 1: the value that proves nothing parsed it into a number.
      amountRaw: "18446744073709551615",
      decimals: 9,
    },
    {
      mint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
      symbol: "UNKNOWN",
      // 1.50 USDC: rendered as whole units it reads as 1.5 million tokens.
      amountRaw: "1500000",
      decimals: null,
    },
  ],
  degraded: false,
  observedAt: "2026-08-26T12:00:00.000Z",
};

function renderCard(wallet: RingsWallet = WALLET) {
  return render(
    <I18nProvider locale="en" messages={getMessages("en")}>
      <ShieldedBalanceCard wallet={wallet} />
    </I18nProvider>
  );
}

/** The refresh control — labelled by aria-label, not visible text. */
function refreshButton(): HTMLButtonElement {
  return screen.getByRole("button", { name: /^(Refresh|Reading…)$/ });
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(cleanup);

describe("ShieldedBalanceCard", () => {
  it("reads nothing until the operator asks", async () => {
    renderCard();

    // A sync is a full indexer scan, so mounting must not trigger one.
    expect(mocks.syncRingsWallet).not.toHaveBeenCalled();
    expect(screen.getByText(/Not read yet/)).toBeTruthy();
    expect(refreshButton().disabled).toBe(false);

    mocks.syncRingsWallet.mockResolvedValue({ sync: OBSERVED });
    await userEvent.setup().click(refreshButton());

    expect(mocks.syncRingsWallet).toHaveBeenCalledExactlyOnceWith(WALLET.id);
  });

  it("announces the read in flight and blocks a second one", async () => {
    let settle: ((result: { sync: RingsWalletSync }) => void) | undefined;
    mocks.syncRingsWallet.mockReturnValue(
      new Promise<{ sync: RingsWalletSync }>((resolve) => {
        settle = resolve;
      })
    );
    renderCard();

    await userEvent.setup().click(refreshButton());

    expect(refreshButton().getAttribute("aria-label")).toBe("Reading…");
    expect(refreshButton().disabled).toBe(true);
    expect(screen.queryByText(/Not read yet/)).toBeNull();

    settle?.({ sync: OBSERVED });
    expect(await screen.findByText("SOL")).toBeTruthy();
    expect(refreshButton().disabled).toBe(false);
  });

  it("renders an asset whose scale the API reported at that scale, exactly", async () => {
    mocks.syncRingsWallet.mockResolvedValue({ sync: OBSERVED });
    renderCard();

    await userEvent.setup().click(refreshButton());

    expect(await screen.findByText("18446744073.709551615")).toBeTruthy();
    expect(screen.getByText("SOL")).toBeTruthy();
    expect(screen.getByText(/^Observed /)).toBeTruthy();
    expect(screen.queryByText(/Partial read/)).toBeNull();
  });

  it("labels an asset whose scale the API did not report as base units", async () => {
    mocks.syncRingsWallet.mockResolvedValue({ sync: OBSERVED });
    renderCard();

    await userEvent.setup().click(refreshButton());

    expect(await screen.findByText("1500000 base units")).toBeTruthy();
    // Neither a guessed six decimals nor a bare count reading as whole tokens.
    expect(screen.queryByText("1.5")).toBeNull();
    expect(screen.queryByText("1500000")).toBeNull();
  });

  it("renders no figure at all for an amount it cannot render exactly", async () => {
    mocks.syncRingsWallet.mockResolvedValue({
      sync: {
        ...OBSERVED,
        balances: [{ mint: "Mint111", symbol: "UNKNOWN", amountRaw: "1.5", decimals: null }],
      },
    });
    renderCard();

    await userEvent.setup().click(refreshButton());

    // A fabricated 0 next to a mint name is worse than no figure.
    expect(await screen.findByText("—")).toBeTruthy();
    expect(screen.queryByText(/base units/)).toBeNull();
  });

  it("separates an observed empty wallet from one nobody has read", async () => {
    mocks.syncRingsWallet.mockResolvedValue({
      sync: { balances: [], degraded: false, observedAt: OBSERVED.observedAt },
    });
    renderCard();

    await userEvent.setup().click(refreshButton());

    expect(await screen.findByText("No shielded notes in this wallet.")).toBeTruthy();
    expect(screen.queryByText(/Not read yet/)).toBeNull();
    expect(screen.getByText(/^Observed /)).toBeTruthy();
  });

  it("surfaces the server's own reason when the read fails", async () => {
    mocks.syncRingsWallet.mockResolvedValue({
      error: "rings wallet has no shielded identity yet; provision it before syncing",
    });
    renderCard();

    await userEvent.setup().click(refreshButton());

    expect(await screen.findByText(/provision it before syncing/)).toBeTruthy();
    // A failure is not a balance, and it is not an empty wallet either.
    expect(screen.queryByText("No shielded notes in this wallet.")).toBeNull();
    expect(screen.queryByText(/^Observed /)).toBeNull();
    expect(refreshButton().disabled).toBe(false);
  });

  it("falls back to its own copy when the failure carried no message", async () => {
    mocks.syncRingsWallet.mockResolvedValue({});
    renderCard();

    await userEvent.setup().click(refreshButton());

    expect(await screen.findByText(/could not be read/)).toBeTruthy();
  });

  // Uncaught, a rejection would leave the button disabled on "Reading…".
  it("answers, and re-enables the read, when the request never returns a reply", async () => {
    mocks.syncRingsWallet.mockRejectedValue(new TypeError("Failed to fetch"));
    renderCard();

    await userEvent.setup().click(refreshButton());

    expect(await screen.findByText(/could not be read/)).toBeTruthy();
    expect(refreshButton().disabled).toBe(false);
  });

  it("marks a degraded read as incomplete rather than as the balance", async () => {
    mocks.syncRingsWallet.mockResolvedValue({ sync: { ...OBSERVED, degraded: true } });
    renderCard();

    await userEvent.setup().click(refreshButton());

    expect(await screen.findByText(/Partial read/)).toBeTruthy();
    // The notes it did read are still the only figures there are.
    expect(screen.getByText("18446744073.709551615")).toBeTruthy();
  });

  it("does not call a degraded read that found nothing an empty wallet", async () => {
    mocks.syncRingsWallet.mockResolvedValue({
      sync: { balances: [], degraded: true, observedAt: OBSERVED.observedAt },
    });
    renderCard();

    await userEvent.setup().click(refreshButton());

    expect(await screen.findByText(/Partial read/)).toBeTruthy();
    expect(screen.queryByText("No shielded notes in this wallet.")).toBeNull();
  });

  it("refuses to offer a read for a wallet with no shielded identity", () => {
    renderCard({ ...WALLET, shieldedAddress: null, status: "pending" });

    expect(refreshButton().disabled).toBe(true);
    expect(screen.queryByText(/Not read yet/)).toBeNull();
    expect(mocks.syncRingsWallet).not.toHaveBeenCalled();
  });

  // A disabled button is not focusable, so its tooltip reaches neither the
  // keyboard nor a screen reader; the reason has to be text.
  it("says why the read is unavailable somewhere reachable, not on the disabled button", () => {
    renderCard({ ...WALLET, shieldedAddress: null, status: "pending" });

    expect(screen.getByText(/no shielded identity yet/)).toBeTruthy();
  });
});
