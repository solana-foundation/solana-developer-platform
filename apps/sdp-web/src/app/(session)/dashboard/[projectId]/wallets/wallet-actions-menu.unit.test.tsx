// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import useSWR, { type Key } from "swr";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stubClerkSession } from "@/test/clerk";
import { syntheticWalletAddress, walletsWorkspace } from "@/test/wallets";
import * as custodyActions from "./actions";
import { custodyQueryKeys } from "./custody-query-key";
import { WalletActionsMenu } from "./wallet-actions-menu";

vi.mock("next/navigation", () => import("@/test/next-navigation"));

beforeEach(() => {
  stubClerkSession();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

type BalancesRead = () => Promise<Record<string, never[]>>;

/** A balances read sharing the page's SWR cache with the menu. */
function Balances({ swrKey, read }: { swrKey: Key; read: BalancesRead }) {
  useSWR(swrKey, read);
  return null;
}

/** Mounts the menu beside the wallet cards' balances read and the wallet page's own. */
function renderMenu(reads: { card: BalancesRead; page: BalancesRead }) {
  render(
    <>
      <WalletActionsMenu
        walletAddress={syntheticWalletAddress(1)}
        walletId="wallet_1"
        walletLabel="Ops"
      />
      <Balances swrKey={custodyQueryKeys.walletCardBalances()} read={reads.card} />
      <Balances
        swrKey={custodyQueryKeys.walletBalances({ walletId: "wallet_1", readAt: 1 })}
        read={reads.page}
      />
    </>,
    { wrapper: walletsWorkspace("admin") }
  );
  const user = userEvent.setup();
  const trigger = () => screen.getByRole("button", { name: "Wallet actions for Ops" });
  return async (item: string) => {
    await waitFor(() => expect(trigger().hasAttribute("disabled")).toBe(false));
    await user.click(trigger());
    await user.click(await screen.findByRole("menuitem", { name: item }));
    await waitFor(() => expect(trigger().hasAttribute("disabled")).toBe(false));
  };
}

describe("WalletActionsMenu", () => {
  // The action itself carries no Idempotency-Key; the menu must not hold the first answer either.
  it("runs the signer check again after a failed press", async () => {
    const check = vi
      .spyOn(custodyActions, "checkWalletSignerMemoAction")
      .mockResolvedValueOnce({ status: "error", message: "signer unreachable" })
      .mockResolvedValueOnce({ status: "success", walletId: "wallet_1", signature: "sig" });
    const choose = renderMenu({ card: async () => ({}), page: async () => ({}) });

    await choose("Prove ownership");
    await choose("Prove ownership");

    expect(check.mock.calls).toEqual([["wallet_1"], ["wallet_1"]]);
  });

  it("re-reads the cards' and the wallet page's balances once the faucet has funded the wallet", async () => {
    const faucet = vi.spyOn(custodyActions, "requestDevnetSolanaFaucetAction").mockResolvedValue({
      status: "success",
      walletId: "wallet_1",
      signature: "sig_airdrop",
      amountSol: 1,
    });
    const card = vi.fn(async () => ({}));
    const page = vi.fn(async () => ({}));
    const choose = renderMenu({ card, page });
    await waitFor(() => expect(card).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(page).toHaveBeenCalledTimes(1));

    await choose("Request devnet SOL");

    expect(faucet.mock.calls).toEqual([["wallet_1"]]);
    await waitFor(() => expect(card).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(page).toHaveBeenCalledTimes(2));
  });

  it("leaves the cached balances alone when the faucet refuses", async () => {
    vi.spyOn(custodyActions, "requestDevnetSolanaFaucetAction").mockResolvedValue({
      status: "error",
      message: "Rate limited",
    });
    const card = vi.fn(async () => ({}));
    const page = vi.fn(async () => ({}));
    const choose = renderMenu({ card, page });
    await waitFor(() => expect(card).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(page).toHaveBeenCalledTimes(1));

    await choose("Request devnet SOL");

    expect(card).toHaveBeenCalledTimes(1);
    expect(page).toHaveBeenCalledTimes(1);
  });
});
