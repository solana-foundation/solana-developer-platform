import { describe, expect, it } from "vitest";
import { clamp01, easeInOutCubic, easeInOutQuad, easeOutCubic } from "./easing";

describe("easing", () => {
  it("starts at 0, ends at 1 and passes through the midpoint", () => {
    for (const ease of [easeOutCubic, easeInOutCubic, easeInOutQuad]) {
      expect(ease(0)).toBe(0);
      expect(ease(1)).toBe(1);
    }
    expect(easeInOutCubic(0.5)).toBeCloseTo(0.5);
    expect(easeInOutQuad(0.5)).toBeCloseTo(0.5);
    expect(easeOutCubic(0.5)).toBeCloseTo(0.875);
  });

  it("holds the cubic curves at their ends past the range", () => {
    expect(clamp01(1.5)).toBe(1);
    expect(clamp01(-0.5)).toBe(0);
    expect(easeOutCubic(1.5)).toBe(1);
    expect(easeInOutCubic(-1)).toBe(0);
  });
});
