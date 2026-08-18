import { describe, expect, it } from "vitest";
import { SERIES_COLOR_COUNT, seriesColorForMint } from "./home-series-color";

describe("seriesColorForMint", () => {
  it("gives a mint the same color every time", () => {
    expect(seriesColorForMint("So11111111111111111111111111111111111111112")).toBe(
      seriesColorForMint("So11111111111111111111111111111111111111112")
    );
  });

  it("does not repaint a token when its rank changes", () => {
    // The bar is ordered by value, so balances moving used to swap the colors of
    // tokens that had not themselves changed. Color follows the entity, not rank.
    const usdc = seriesColorForMint("mint-usdc");
    const sol = seriesColorForMint("mint-sol");
    expect(usdc).not.toBe(undefined);
    expect(seriesColorForMint("mint-usdc")).toBe(usdc);
    expect(seriesColorForMint("mint-sol")).toBe(sol);
  });

  it("only ever returns a defined series slot", () => {
    for (const mint of ["a", "b", "c", "d", "e", "f", "g", "mint-usdc", "mint-sol"]) {
      expect(seriesColorForMint(mint)).toMatch(/^bg-series-[1-4]$/);
    }
  });

  it("spreads across every slot rather than favouring one", () => {
    const seen = new Set(
      Array.from({ length: 200 }, (_, index) => seriesColorForMint(`mint-${index}`))
    );
    expect(seen.size).toBe(SERIES_COLOR_COUNT);
  });

  it("is stable for an empty mint rather than throwing", () => {
    expect(seriesColorForMint("")).toMatch(/^bg-series-[1-4]$/);
  });
});
