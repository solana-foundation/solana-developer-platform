import { describe, expect, it } from "vitest";
import { SERIES_COLOR_COUNT, SERIES_COLORS, seriesColorForMint } from "./home-series-color";

// An independent FNV-1a reference written from the published algorithm (32-bit
// offset basis 2166136261, prime 16777619), not from the implementation. The
// contract is that a mint wears the same color on every screen forever, so a
// change to the hash — which would silently repaint every existing token —
// must fail here rather than ship.
function specFnv1a(input: string): number {
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash;
}

describe("seriesColorForMint", () => {
  it("derives the slot from FNV-1a, so colors survive releases and machines", () => {
    for (const mint of [
      "So11111111111111111111111111111111111111112",
      "mint-usdc",
      "mint-sol",
      "",
    ]) {
      expect(seriesColorForMint(mint)).toBe(SERIES_COLORS[specFnv1a(mint) % SERIES_COLORS.length]);
    }
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
});
