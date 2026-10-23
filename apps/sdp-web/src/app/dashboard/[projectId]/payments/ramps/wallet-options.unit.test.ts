import type { PaymentsDashboardWallet } from "@sdp/types/payments";
import { SOL_MINT, SOLANA_CLUSTERS, WELL_KNOWN_TOKENS } from "@sdp/types/well-known-tokens";
import { describe, expect, it } from "vitest";
import { onchainPaymentAssetOptions, walletComboboxOptions } from "./wallet-options";

describe("walletComboboxOptions", () => {
  it("uses exact wallet ids and keeps duplicate Provider ids selectable", () => {
    const wallets: PaymentsDashboardWallet[] = [
      {
        id: "cwlt_1",
        walletId: "privy_shared",
        publicKey: "address_1",
        label: "Primary",
        isRuntimeExecutionAllowed: true,
      },
      {
        id: "cwlt_2",
        walletId: "privy_shared",
        publicKey: "address_2",
        label: null,
        isRuntimeExecutionAllowed: true,
      },
    ];

    expect(walletComboboxOptions(wallets)).toMatchObject([
      { value: "cwlt_1", label: "Primary" },
      { value: "cwlt_2", label: "address_2" },
    ]);
  });

  it("marks signing unavailable without hiding the same wallet from receiving", () => {
    const wallets: PaymentsDashboardWallet[] = [
      {
        id: "cwlt_connection",
        walletId: "privy_shared",
        custodyConnectionId: "cconn_other",
        publicKey: "address_1",
        label: "Treasury",
        isRuntimeExecutionAllowed: false,
      },
    ];

    expect(walletComboboxOptions(wallets, "Signing unavailable")).toMatchObject([
      { value: "cwlt_connection", label: "Treasury", badge: "Signing unavailable" },
    ]);
    expect(walletComboboxOptions(wallets)).toEqual([
      { value: "cwlt_connection", label: "Treasury", description: undefined },
    ]);
  });

  it("disables only restricted wallets when asked to", () => {
    const wallets: PaymentsDashboardWallet[] = [
      {
        id: "cwlt_ok",
        walletId: "privy_ok",
        publicKey: "address_ok",
        label: "Treasury",
        isRuntimeExecutionAllowed: true,
      },
      {
        id: "cwlt_off",
        walletId: "privy_off",
        publicKey: "address_off",
        label: "BYOK Test",
        isRuntimeExecutionAllowed: false,
      },
    ];

    expect(walletComboboxOptions(wallets, "Restricted", { disableRestricted: true })).toEqual([
      { value: "cwlt_ok", label: "Treasury", description: undefined },
      {
        value: "cwlt_off",
        label: "BYOK Test",
        description: undefined,
        badge: "Restricted",
        badgeVariant: "warning",
        disabled: true,
      },
    ]);
    // Without the flag the same wallet stays selectable: drafts and receiving need it.
    expect(walletComboboxOptions(wallets, "Restricted")[1]).not.toHaveProperty("disabled");
  });
});

describe("onchainPaymentAssetOptions", () => {
  it.each(SOLANA_CLUSTERS)("limits Fireblocks BYOK to canonical SOL and USDC on %s", (cluster) => {
    const usdc = WELL_KNOWN_TOKENS.USDC.mints[cluster].address;
    const wrongClusterUsdc =
      WELL_KNOWN_TOKENS.USDC.mints[cluster === "devnet" ? "mainnet-beta" : "devnet"].address;
    const wallet: PaymentsDashboardWallet = {
      id: "cwlt_fireblocks",
      walletId: "fb_0",
      publicKey: "address",
      label: "Treasury",
      provider: "fireblocks",
      custodyConnectionId: "cconn_fireblocks",
      isRuntimeExecutionAllowed: true,
      balances: [SOL_MINT, usdc, wrongClusterUsdc, "unsupported-mint"].map((mint) => ({
        mint,
        token: mint === SOL_MINT ? "SOL" : "USDC",
        amount: "1000000000",
        uiAmount: "1",
        decimals: 9,
      })),
    };
    const options = (value: PaymentsDashboardWallet) =>
      onchainPaymentAssetOptions(value, {}, (key) => key, cluster).map((option) => option.value);
    expect(options(wallet)).toEqual([SOL_MINT, usdc]);
    // Preserve other custody paths, including managed Fireblocks and Privy BYOK.
    expect(options({ ...wallet, custodyConnectionId: undefined })).toHaveLength(4);
    expect(options({ ...wallet, provider: "privy" })).toHaveLength(4);
  });
});
