import { SOL_MINT, tokenFilterAliases } from "@sdp/types";
import { describe, expect, it } from "vitest";

describe("tokenFilterAliases", () => {
  it("matches the symbol rows when given a mint", () => {
    // payment_transfers.token stores SOL both as this mint and as "SOL".
    const aliases = tokenFilterAliases(SOL_MINT);
    expect(aliases).toContain(SOL_MINT);
    expect(aliases).toContain("SOL");
  });

  it("matches the mint rows when given a symbol", () => {
    const aliases = tokenFilterAliases("SOL");
    expect(aliases).toContain("SOL");
    expect(aliases).toContain(SOL_MINT);
  });

  it("covers every cluster's mint for a symbol", () => {
    const aliases = tokenFilterAliases("USDC");
    expect(aliases).toContain("USDC");
    expect(aliases.length).toBeGreaterThan(1);
  });

  it("resolves a devnet mint to its symbol as well", () => {
    // Devnet USDC. The local ledger holds rows under this mint, so a filter that
    // only knew the mainnet address would miss them.
    const devnetUsdc = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
    expect(tokenFilterAliases(devnetUsdc)).toContain(devnetUsdc);
    expect(tokenFilterAliases(devnetUsdc)).toContain("USDC");
  });

  it("passes through a mint the catalogue has never heard of", () => {
    const unknown = "MintNobodyHasEverIssued1111111111111111111111";
    expect(tokenFilterAliases(unknown)).toEqual([unknown]);
  });

  it("returns nothing for a blank filter", () => {
    expect(tokenFilterAliases("   ")).toEqual([]);
  });

  it("does not duplicate when a token resolves to itself", () => {
    const aliases = tokenFilterAliases(SOL_MINT);
    expect(new Set(aliases).size).toBe(aliases.length);
  });
});
