import { describe, expect, it } from "vitest";
import { captionOpacity } from "./builders-section";

describe("the builders' caption timing", () => {
  it("fades the opening caption in over its first fifth and out over its last", () => {
    expect(captionOpacity(0, 0, 2)).toBe(0);
    expect(captionOpacity(0.05, 0, 2)).toBeCloseTo(0.5);
    expect(captionOpacity(0.25, 0, 2)).toBe(1);
    expect(captionOpacity(0.45, 0, 2)).toBeCloseTo(0.5);
    expect(captionOpacity(0.6, 0, 2)).toBe(0);
  });

  it("keeps the closing caption once it has come in", () => {
    expect(captionOpacity(0.4, 1, 2)).toBe(0);
    expect(captionOpacity(0.55, 1, 2)).toBeCloseTo(0.5);
    expect(captionOpacity(0.9, 1, 2)).toBe(1);
    expect(captionOpacity(1, 1, 2)).toBe(1);
  });
});
