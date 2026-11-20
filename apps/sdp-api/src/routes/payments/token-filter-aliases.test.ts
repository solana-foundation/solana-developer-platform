import { SOL_MINT, tokenFilterAliases } from "@sdp/types/well-known-tokens";
import { describe, expect, it } from "vitest";

const DEVNET_USDC = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const MAINNET_USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const JITO_MINT = "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn";

// A token list filter matches every form `payment_transfers.token` may hold for the asset:
// the input, its catalogue key, its display symbol and each cluster's mint.
describe("tokenFilterAliases", () => {
  it("expands a symbol to every cluster's mint", () => {
    expect(new Set(tokenFilterAliases("USDC"))).toEqual(
      new Set(["USDC", DEVNET_USDC, MAINNET_USDC])
    );
  });

  it("expands one cluster's mint to its symbol and the other cluster's mint", () => {
    expect(new Set(tokenFilterAliases(DEVNET_USDC))).toEqual(
      new Set(["USDC", DEVNET_USDC, MAINNET_USDC])
    );
    expect(new Set(tokenFilterAliases(SOL_MINT))).toEqual(new Set(["SOL", SOL_MINT]));
  });

  it("expands a mixed-case asset to its catalogue key, display symbol and mint, from any form", () => {
    const jito = new Set(["JITOSOL", "JitoSOL", JITO_MINT]);
    for (const form of [JITO_MINT, "JITOSOL", "JitoSOL"]) {
      expect(new Set(tokenFilterAliases(form))).toEqual(jito);
    }
    // Any other spelling also matches itself.
    expect(new Set(tokenFilterAliases(" jItOsOl "))).toEqual(new Set([...jito, "jItOsOl"]));
  });

  it("passes through a mint the catalogue has never heard of", () => {
    const unknown = "MintNobodyHasEverIssued1111111111111111111111";
    expect(tokenFilterAliases(unknown)).toEqual([unknown]);
  });

  it("returns nothing for a blank filter", () => {
    expect(tokenFilterAliases("   ")).toEqual([]);
  });
});
