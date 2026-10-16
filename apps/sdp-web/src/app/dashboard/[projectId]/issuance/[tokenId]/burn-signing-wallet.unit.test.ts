import { describe, expect, it } from "vitest";
import { resolveBurnSigningWalletId } from "./token-management-workspace.utils";

describe("resolveBurnSigningWalletId", () => {
  it("keeps the burn's own default signer, with or without demo mode", () => {
    for (const demo of [true, false]) {
      expect(
        resolveBurnSigningWalletId({
          burnDefaultWalletId: "wallet_burn",
          mintDefaultWalletId: "wallet_mint",
          demo,
        })
      ).toBe("wallet_burn");
    }
  });

  it("opens a demo burn on the mint's signer when several wallets could sign it", () => {
    expect(
      resolveBurnSigningWalletId({
        burnDefaultWalletId: "",
        mintDefaultWalletId: "wallet_mint",
        demo: true,
      })
    ).toBe("wallet_mint");
  });

  it("leaves a real burn without a signer until one is picked", () => {
    expect(
      resolveBurnSigningWalletId({
        burnDefaultWalletId: "",
        mintDefaultWalletId: "wallet_mint",
        demo: false,
      })
    ).toBe("");
  });
});
