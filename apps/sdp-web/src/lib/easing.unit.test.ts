import { describe, expect, it } from "vitest";
import { clamp, easeOutCubic } from "./easing";

describe("clamp", () => {
  it("holds a value to 0..1 by default, or to the range given", () => {
    expect(clamp(-0.5)).toBe(0);
    expect(clamp(0.25)).toBe(0.25);
    expect(clamp(3)).toBe(1);
    expect(clamp(12, 0, 10)).toBe(10);
    expect(clamp(-4, -2, 2)).toBe(-2);
  });
});

describe("easeOutCubic", () => {
  it("eases out from 0 to 1, held to 0..1 outside it", () => {
    expect(easeOutCubic(0)).toBe(0);
    expect(easeOutCubic(1)).toBe(1);
    expect(easeOutCubic(0.5)).toBeCloseTo(0.875);
    expect(easeOutCubic(-1)).toBe(0);
    expect(easeOutCubic(2)).toBe(1);
  });
});
