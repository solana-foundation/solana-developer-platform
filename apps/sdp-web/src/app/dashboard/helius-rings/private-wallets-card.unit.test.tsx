// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import type { RingsWallet } from "./helius-rings.data";
import { PrivateWalletsCard } from "./private-wallets-card";

const mocks = vi.hoisted(() => ({ createRingsWallet: vi.fn() }));

vi.mock("./helius-rings.data", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./helius-rings.data")>()),
  createRingsWallet: mocks.createRingsWallet,
}));

vi.mock("./wallet-identity-check", () => ({
  WalletIdentityCheck: () => null,
}));

vi.mock("./shielded-balance-card", () => ({
  ShieldedBalanceCard: () => null,
}));

const PENDING: RingsWallet = {
  id: "hrw_pending",
  sdpWalletId: "wal_pending",
  name: "Treasury",
  shieldedAddress: null,
  status: "pending",
  network: "devnet",
};

const PAUSED: RingsWallet = {
  id: "hrw_paused",
  sdpWalletId: "wal_paused",
  name: "Payroll",
  shieldedAddress: null,
  status: "paused",
  network: "devnet",
};

const READY: RingsWallet = {
  id: "hrw_ready",
  sdpWalletId: "wal_ready",
  name: "Ops",
  shieldedAddress: "rings1ops",
  status: "ready",
  network: "devnet",
};

const CUSTODY = [
  { walletId: "wal_pending", label: "Treasury custody", publicKey: "Pending111" },
  { walletId: "wal_paused", label: "Payroll custody", publicKey: "Paused1111" },
  { walletId: "wal_ready", label: "Ops custody", publicKey: "Ready11111" },
];

function renderCard(wallets: readonly RingsWallet[], onWalletsChanged = vi.fn(async () => {})) {
  render(
    <I18nProvider locale="en" messages={getMessages("en")}>
      <PrivateWalletsCard
        wallets={wallets}
        custodyWallets={CUSTODY}
        availableCustodyWallets={[]}
        selectedWalletId={null}
        onSelect={vi.fn()}
        balancesTick={0}
        onWalletsChanged={onWalletsChanged}
      />
    </I18nProvider>
  );
  return { onWalletsChanged };
}

function retryButton(): HTMLButtonElement {
  return screen.getByRole("button", { name: /^(Retry provision|Provisioning…)$/ });
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(cleanup);

describe("PrivateWalletsCard retry provision", () => {
  it("offers retry only on a pending row with no shielded address", () => {
    renderCard([PENDING, PAUSED, READY]);

    expect(screen.getAllByRole("button", { name: "Retry provision" })).toHaveLength(1);
    expect(mocks.createRingsWallet).not.toHaveBeenCalled();
  });

  it("announces the replay in flight and blocks a second click", async () => {
    let settle: ((result: { wallet: RingsWallet }) => void) | undefined;
    mocks.createRingsWallet.mockReturnValue(
      new Promise<{ wallet: RingsWallet }>((resolve) => {
        settle = resolve;
      })
    );
    renderCard([PENDING]);

    await userEvent.setup().click(retryButton());

    expect(retryButton().textContent).toBe("Provisioning…");
    expect(retryButton().disabled).toBe(true);
    expect(mocks.createRingsWallet).toHaveBeenCalledTimes(1);

    settle?.({ wallet: { ...PENDING, status: "ready", shieldedAddress: "rings1treasury" } });
    expect(await screen.findByRole("button", { name: "Retry provision" })).toBeTruthy();
    expect(retryButton().disabled).toBe(false);
  });

  it("replays create on the bound custody wallet and refreshes after success", async () => {
    const ready = { ...PENDING, status: "ready" as const, shieldedAddress: "rings1treasury" };
    mocks.createRingsWallet.mockResolvedValue({ wallet: ready });
    const { onWalletsChanged } = renderCard([PENDING]);

    await userEvent.setup().click(retryButton());

    expect(mocks.createRingsWallet).toHaveBeenCalledExactlyOnceWith({
      walletId: PENDING.sdpWalletId,
      name: PENDING.name,
    });
    await waitFor(() => expect(onWalletsChanged).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows the create error and still refreshes so the row can be retried", async () => {
    mocks.createRingsWallet.mockResolvedValue({ error: "owner unfunded" });
    const { onWalletsChanged } = renderCard([PENDING]);

    await userEvent.setup().click(retryButton());

    expect(await screen.findByRole("alert")).toHaveTextContent("owner unfunded");
    await waitFor(() => expect(onWalletsChanged).toHaveBeenCalledTimes(1));
    expect(retryButton().disabled).toBe(false);
  });
});
