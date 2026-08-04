import { describe, expect, it } from "vitest";
import {
  HEADER_APPEARANCE_DEFAULTS,
  HEADER_APPEARANCE_VALUES,
  normalizeHeaderAppearance,
} from "./header-appearance";

describe("normalizeHeaderAppearance", () => {
  it("falls back to the defaults for anything that isn't an appearance object", () => {
    for (const raw of [null, undefined, "default", 4, []]) {
      expect(normalizeHeaderAppearance(raw), String(raw)).toEqual(HEADER_APPEARANCE_DEFAULTS);
    }
  });

  it("keeps every stored value that is still offered", () => {
    // One non-default value per axis, so nothing can pass by falling back.
    const stored = { layout: "mirrored", mode: "expanded" };
    expect(Object.keys(stored).sort()).toEqual(Object.keys(HEADER_APPEARANCE_VALUES).sort());
    expect(normalizeHeaderAppearance(stored)).toEqual(stored);
  });

  it("replaces only the axes it cannot recognise", () => {
    // `compact` was the old name for the default mode: a stored value from before
    // the rename falls back rather than taking the whole appearance with it.
    const appearance = normalizeHeaderAppearance({ layout: "mirrored", mode: "compact" });
    expect(appearance.layout).toBe("mirrored");
    expect(appearance.mode).toBe(HEADER_APPEARANCE_DEFAULTS.mode);

    // Extra keys from an older, larger shape are ignored rather than kept.
    expect(normalizeHeaderAppearance({ tickerBadge: "fill-pill" })).toEqual(
      HEADER_APPEARANCE_DEFAULTS
    );
  });

  it("offers a default that is one of its own values, for each axis", () => {
    for (const [key, values] of Object.entries(HEADER_APPEARANCE_VALUES)) {
      expect(values, `${key} default`).toContain(
        HEADER_APPEARANCE_DEFAULTS[key as keyof typeof HEADER_APPEARANCE_DEFAULTS]
      );
    }
  });
});
