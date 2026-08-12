import { describe, expect, it } from "vitest";
import { letterMarkTypeClassName, resolveLogoQuality } from "./asset-profile-header";

const RASTER = "https://cdn.test/logo.png";

function quality(naturalWidth: number, naturalHeight = naturalWidth, boxSize = 208, url = RASTER) {
  return resolveLogoQuality({ url, naturalWidth, naturalHeight, boxSize });
}

describe("resolveLogoQuality", () => {
  it("fills the box when the raster has at least as many pixels as the box", () => {
    expect(quality(208)).toBe("sharp");
    expect(quality(512)).toBe("sharp");
  });

  it("insets a raster that would have to be upscaled", () => {
    expect(quality(128)).toBe("lowRes");
    expect(quality(207)).toBe("lowRes");
  });

  it("uses the smaller dimension, so a wide-but-short source still insets", () => {
    expect(quality(1024, 96)).toBe("lowRes");
  });

  it("rejects sources with too little detail to be worth showing", () => {
    expect(quality(63)).toBe("unusable");
    expect(quality(16)).toBe("unusable");
    expect(quality(64)).toBe("lowRes");
  });

  it("treats vectors as sharp regardless of reported intrinsic size", () => {
    expect(quality(16, 16, 208, "https://cdn.test/logo.svg")).toBe("sharp");
    expect(quality(0, 0, 208, "https://cdn.test/logo.svg?v=2")).toBe("sharp");
    expect(quality(1, 1, 208, "data:image/svg+xml;base64,AAAA")).toBe("sharp");
  });

  it("treats an unreported intrinsic size as sharp, since viewBox-only SVGs scale", () => {
    expect(quality(0)).toBe("sharp");
  });

  it("re-decides as the box grows, so the same source can inset at a larger size", () => {
    expect(quality(200, 200, 160)).toBe("sharp");
    expect(quality(200, 200, 256)).toBe("lowRes");
  });
});

describe("letterMarkTypeClassName", () => {
  // Real tickers cluster at four to six characters (CMPH5, ALDRB, abUSD3), and the
  // mark they sit in is the stepped-down 96px circle — so the middle of the table
  // is the case that matters, not the one-character end.
  it("sizes the whole symbol to fit the stepped-down mark", () => {
    expect(letterMarkTypeClassName("H")).toBe("text-2xl");
    expect(letterMarkTypeClassName("HRB")).toBe("text-xl");
    expect(letterMarkTypeClassName("LTIF")).toBe("text-lg");
    expect(letterMarkTypeClassName("ALDRB")).toBe("text-base");
    expect(letterMarkTypeClassName("abUSD3")).toBe("text-sm");
    expect(letterMarkTypeClassName("HRB2029")).toBe("text-xs");
  });

  it("never steps back up as the symbol lengthens", () => {
    // Tailwind's scale, largest first.
    const scale = [
      "text-3xl",
      "text-2xl",
      "text-xl",
      "text-lg",
      "text-base",
      "text-sm",
      "text-xs",
      "text-[10px]",
    ];
    const steps = Array.from({ length: 12 }, (_, index) =>
      scale.indexOf(letterMarkTypeClassName("X".repeat(index + 1)))
    );
    expect(steps.every((step) => step >= 0)).toBe(true);
    for (const [index, step] of steps.entries()) {
      if (index > 0) {
        expect(step, `${index + 1} characters`).toBeGreaterThanOrEqual(steps[index - 1] ?? 0);
      }
    }
  });

  it("holds the smallest step past the longest symbol it plans for", () => {
    // A symbol can run to ten characters; nothing may overflow the mark.
    expect(letterMarkTypeClassName("ABCDEFGHIJ")).toBe("text-[10px]");
    expect(letterMarkTypeClassName("ABCDEFGHIJKL")).toBe("text-[10px]");
  });
});
