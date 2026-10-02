import { describe, expect, it } from "vitest";
import { formatSampleAmount, SAMPLE_AMOUNTS, sampleSlot } from "./sample-payments";

describe("formatSampleAmount", () => {
  it("formats with two decimals and the asset, in the viewer's locale", () => {
    expect(formatSampleAmount(0, "en")).toBe("12,500.00 USDC");
    expect(formatSampleAmount(5, "en")).toBe("3,300.00 EURC");
    // French groups with a narrow no-break space and uses a decimal comma.
    expect(formatSampleAmount(0, "fr")).toBe("12 500,00 USDC");
  });

  it("wraps round the list, so any payment count has an amount", () => {
    expect(formatSampleAmount(SAMPLE_AMOUNTS.length, "en")).toBe(formatSampleAmount(0, "en"));
    expect(formatSampleAmount(SAMPLE_AMOUNTS.length * 3 + 1, "en")).toBe("840.00 USDC");
  });
});

describe("sampleSlot", () => {
  it("is a formatted slot number in the recent range", () => {
    for (let i = 0; i < 20; i++) {
      const slot = Number(sampleSlot("en").replaceAll(",", ""));
      expect(slot).toBeGreaterThanOrEqual(291_044_000);
      expect(slot).toBeLessThan(291_053_000);
    }
  });
});
