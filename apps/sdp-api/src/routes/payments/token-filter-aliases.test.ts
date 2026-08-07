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

  it("expands a mixed-case display symbol to its mint", () => {
    // The catalogue is keyed JITOSOL while the entry's symbol is JitoSOL, and the
    // ledger stores the display form. Matching the key exactly made this
    // asymmetric: the mint expanded to JitoSOL, but JitoSOL did not expand back.
    const jitoMint = "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn";

    expect(tokenFilterAliases("JitoSOL")).toContain(jitoMint);
    expect(tokenFilterAliases(jitoMint)).toContain("JitoSOL");
  });

  it("round-trips every mixed-case catalogue symbol through its mint", () => {
    for (const symbol of ["JitoSOL", "mSOL", "bSOL", "cbBTC"]) {
      const aliases = tokenFilterAliases(symbol);
      const mints = aliases.filter((alias) => alias.length > 30);
      expect(mints.length).toBeGreaterThan(0);

      // Whichever mint the ledger used, filtering by it has to come back to the
      // same symbol, or the two directions disagree again.
      for (const mint of mints) {
        expect(tokenFilterAliases(mint)).toContain(symbol);
      }
    }
  });

  it("matches the schema-normalised key rows when given a mint", () => {
    // paymentTokenSchema upper-cases symbols before storage-bound paths, so the
    // ledger can hold JITOSOL where the display form is JitoSOL. A mint filter
    // has to reach those rows too.
    const jitoMint = "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn";
    const aliases = tokenFilterAliases(jitoMint);
    expect(aliases).toContain("JITOSOL");
    expect(aliases).toContain("JitoSOL");
  });

  it("expands a mint and its symbol to the same alias set", () => {
    const jitoMint = "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn";
    expect(new Set(tokenFilterAliases(jitoMint))).toEqual(new Set(tokenFilterAliases("JitoSOL")));
  });

  it("resolves a symbol whatever casing it arrives in", () => {
    const jitoMint = "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn";
    for (const spelling of ["JITOSOL", "jitosol", "JitoSOL", "jItOsOl"]) {
      expect(tokenFilterAliases(spelling)).toContain(jitoMint);
    }
  });

  it("does not duplicate when a token resolves to itself", () => {
    const aliases = tokenFilterAliases(SOL_MINT);
    expect(new Set(aliases).size).toBe(aliases.length);
  });
});
