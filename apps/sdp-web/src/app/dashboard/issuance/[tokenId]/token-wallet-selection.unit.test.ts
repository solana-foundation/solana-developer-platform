import type { PaymentsDashboardWallet, Token } from "@sdp/types";
import { describe, expect, it } from "vitest";
import {
  findWalletByCustodyWalletId,
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

  it.each(["mint", "seize", "force-burn", "freeze", "authority"] as const)(
    "requires an exact choice for duplicate %s authority wallets",
    (action) => {
      const selection = getSignerSelectionForAction({
        action,
        token: {
          ...token,
          mintAuthority: "authority",
          freezeAuthority: "authority",
        } as Token,
        authorityWallets: duplicateAuthorityWallets,
        metadataAuthority: "authority",
        t,
      });

      expect(selection.wallets).toEqual(duplicateAuthorityWallets);
      expect(selection.defaultWalletId).toBe("");
      expect(selection.unavailableReason).toBeNull();
    }
  );

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

  it("blocks ambiguous pause because its endpoint has no exact selector", () => {
    const selection = getSignerSelectionForAction({
      action: "pause",
      token: { ...token, mintAuthority: "authority" } as Token,
      authorityWallets: duplicateAuthorityWallets,
      metadataAuthority: null,
      t,
    });

    expect(selection.wallets).toEqual(duplicateAuthorityWallets);
    expect(selection.defaultWalletId).toBe("");
    expect(selection.unavailableReason).toBe(
      "DashboardIssuance.management.requiredSignerAmbiguous"
    );
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
