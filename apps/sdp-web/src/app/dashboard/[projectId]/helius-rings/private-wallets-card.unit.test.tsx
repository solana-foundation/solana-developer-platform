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
  custodyWalletId: "cwlt_pending",
  name: "Treasury",
  shieldedAddress: null,
  status: "pending",
  network: "devnet",
};

const PAUSED: RingsWallet = {
  id: "hrw_paused",
  custodyWalletId: "cwlt_paused",
  name: "Payroll",
  shieldedAddress: null,
  status: "paused",
  network: "devnet",
};

const READY: RingsWallet = {
  id: "hrw_ready",
  custodyWalletId: "cwlt_ready",
  name: "Ops",
  shieldedAddress: "rings1ops",
  status: "ready",
  network: "devnet",
};

const CUSTODY = [
  { id: "cwlt_pending", label: "Treasury custody", publicKey: "Pending111" },
  { id: "cwlt_paused", label: "Payroll custody", publicKey: "Paused1111" },
  { id: "cwlt_ready", label: "Ops custody", publicKey: "Ready11111" },
];

function renderCard(
  wallets: readonly RingsWallet[],
  onWalletsChanged = vi.fn(async () => {}),
  availableCustodyWallets: typeof CUSTODY = []
) {
  render(
    <I18nProvider locale="en" messages={getMessages("en")}>
      <PrivateWalletsCard
        wallets={wallets}
        custodyWallets={CUSTODY}
        availableCustodyWallets={availableCustodyWallets}
        selectedWalletId={null}
        onSelect={vi.fn()}
        balancesTick={0}
        canWrite
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
  it("creates from the selected internal inventory ID without a provider field", async () => {
    mocks.createRingsWallet.mockResolvedValue({ wallet: READY });
    renderCard(
      [],
      vi.fn(async () => {}),
      CUSTODY
    );
    const user = userEvent.setup();

    await user.click(screen.getByRole("combobox", { name: "Custody wallet" }));
    await user.click(await screen.findByRole("option", { name: "Ops custody" }));
    await user.type(screen.getByLabelText("Private wallet name"), "Ops");
    await user.click(screen.getByRole("button", { name: "Create private wallet" }));

    expect(mocks.createRingsWallet).toHaveBeenCalledExactlyOnceWith({
      custodyWalletId: "cwlt_ready",
      name: "Ops",
    });
  });

  it("offers retry only on a pending row with no shielded address", () => {
    renderCard([PENDING, PAUSED, READY]);

    expect(screen.getAllByRole("button", { name: "Retry provision" })).toHaveLength(1);
    expect(mocks.createRingsWallet).not.toHaveBeenCalled();
  });

  it("replays the migrated internal ID when custody inventory has no matching label", async () => {
    const wallet = { ...PENDING, custodyWalletId: "cwlt_retained" };
    mocks.createRingsWallet.mockResolvedValue({ wallet });
    renderCard([wallet]);

    expect(screen.getByText("cwlt_retained")).toBeTruthy();
    expect(retryButton().disabled).toBe(false);
    await userEvent.setup().click(retryButton());
    expect(mocks.createRingsWallet).toHaveBeenCalledExactlyOnceWith({
      custodyWalletId: "cwlt_retained",
      name: "Treasury",
    });
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
      custodyWalletId: PENDING.custodyWalletId,
      name: PENDING.name,
    });
    await waitFor(() => expect(onWalletsChanged).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows the create error and still refreshes so the row can be retried", async () => {
    mocks.createRingsWallet.mockResolvedValue({ error: "owner unfunded" });
    const { onWalletsChanged } = renderCard([PENDING]);

    await userEvent.setup().click(retryButton());

    expect((await screen.findByRole("alert")).textContent).toContain("owner unfunded");
    await waitFor(() => expect(onWalletsChanged).toHaveBeenCalledTimes(1));
    expect(retryButton().disabled).toBe(false);
  });
});
