import type { PaymentsDashboardWallet, Token } from "@sdp/types";
import { describe, expect, it } from "vitest";
import {
  findWalletByCustodyWalletId,
  getDisplayedAuthorityAddress,
  getSignerSelectionForAction,
  getSignerWalletOptionLabel,
} from "./token-management-workspace.utils";

const wallets: PaymentsDashboardWallet[] = [
  { id: "cwlt_a", walletId: "provider_same", publicKey: "address_a", label: "A" },
  { id: "cwlt_b", walletId: "provider_same", publicKey: "address_b", label: "B" },
];

const duplicateAuthorityWallets: PaymentsDashboardWallet[] = [
  { id: "cwlt_config", walletId: "provider_same", publicKey: "authority", label: "Config" },
  {
    id: "cwlt_connection",
    walletId: "provider_same",
    publicKey: "authority",
    label: "Connection",
  },
];

const token = {
  status: "pending",
  signingCustodyWalletId: "cwlt_b",
} as Token;

const t = ((key: string) => key) as Parameters<typeof getSignerSelectionForAction>[0]["t"];

describe("issuance exact wallet selection", () => {
  it("resolves duplicate Provider IDs by the exact SDP wallet ID", () => {
    expect(findWalletByCustodyWalletId(wallets, "cwlt_b")).toBe(wallets[1]);
  });

  it("uses the persisted exact wallet as the direct-deploy default", () => {
    expect(
      getSignerSelectionForAction({
        action: "deploy",
        token,
        authorityWallets: wallets,
        metadataAuthority: null,
        t,
      }).defaultWalletId
    ).toBe("cwlt_b");
  });

  it("blocks deploy when the persisted exact wallet is unavailable", () => {
    const selection = getSignerSelectionForAction({
      action: "deploy",
      token: { ...token, signingCustodyWalletId: "cwlt_missing" } as Token,
      authorityWallets: wallets,
      metadataAuthority: null,
      t,
    });

    expect(selection.wallets).toEqual(wallets);
    expect(selection.defaultWalletId).toBe("");
    expect(selection.unavailableReason).toBe(
      "DashboardIssuance.management.requiredSignerNotControlled"
    );
  });

  it("does not display another wallet as a missing pending authority", () => {
    expect(
      getDisplayedAuthorityAddress({
        token: {
          ...token,
          signingCustodyWalletId: "cwlt_missing",
          mintAuthority: null,
        } as Token,
        role: "mint",
        metadataAuthority: null,
        authorityWallets: wallets,
      })
    ).toBeNull();
  });

  it.each([
    "mint",
    "seize",
    "force-burn",
    "freeze",
    "authority",
    "pause",
    "metadata",
    "allowlist",
  ] as const)("requires an exact choice for duplicate %s authority wallets", (action) => {
    const selection = getSignerSelectionForAction({
      action,
      token: {
        ...token,
        mintAuthority: "authority",
        freezeAuthority: "authority",
      } as Token,
      authorityWallets: duplicateAuthorityWallets,
      metadataAuthority: "authority",
      allowlistAuthority: "authority",
      t,
    });

    expect(selection.wallets).toEqual(duplicateAuthorityWallets);
    expect(selection.defaultWalletId).toBe("");
    expect(selection.unavailableReason).toBeNull();
  });

  it("keeps the single matching authority wallet selected", () => {
    const selection = getSignerSelectionForAction({
      action: "mint",
      token: { ...token, mintAuthority: "authority" } as Token,
      authorityWallets: [duplicateAuthorityWallets[1]],
      metadataAuthority: null,
      t,
    });

    expect(selection.wallets).toEqual([duplicateAuthorityWallets[1]]);
    expect(selection.defaultWalletId).toBe("cwlt_connection");
  });

  it("does not default burn when the same source address has multiple wallet rows", () => {
    const selection = getSignerSelectionForAction({
      action: "burn",
      token,
      authorityWallets: duplicateAuthorityWallets,
      metadataAuthority: null,
      t,
    });

    expect(selection.wallets).toEqual(duplicateAuthorityWallets);
    expect(selection.defaultWalletId).toBe("");
  });

  it("selects by the list authority rather than the token freeze authority", () => {
    const selection = getSignerSelectionForAction({
      action: "allowlist",
      token: { ...token, freezeAuthority: "address_b" } as Token,
      authorityWallets: wallets,
      metadataAuthority: null,
      allowlistAuthority: "address_a",
      t,
    });

    expect(selection.wallets).toEqual([wallets[0]]);
    expect(selection.defaultWalletId).toBe("cwlt_a");
    expect(selection.unavailableReason).toBeNull();
  });

  it("can distinguish duplicate signer rows by their exact IDs", () => {
    expect(getSignerWalletOptionLabel(duplicateAuthorityWallets[0], t, true)).toContain(
      "cwlt_config"
    );
    expect(getSignerWalletOptionLabel(duplicateAuthorityWallets[1], t, true)).toContain(
      "cwlt_connection"
    );
  });
});
