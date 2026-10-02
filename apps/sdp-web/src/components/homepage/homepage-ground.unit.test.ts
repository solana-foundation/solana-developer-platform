import { describe, expect, it } from "vitest";
import { groundUnder } from "./homepage-ground";

const sections = [
  { ground: "paper", top: -400, bottom: 300 },
  { ground: "night", top: 300, bottom: 1100 },
  { ground: "paper", top: 1100, bottom: 1800 },
];

describe("groundUnder", () => {
  it("takes the ground of the section across the deciding line", () => {
    expect(groundUnder(sections, 200)).toBe("paper");
    expect(groundUnder(sections, 500)).toBe("night");
    expect(groundUnder(sections, 1200)).toBe("paper");
  });

  it("gives a section's own top edge to it, and its bottom edge to the next", () => {
    expect(groundUnder(sections, 300)).toBe("night");
    expect(groundUnder(sections, 1100)).toBe("paper");
  });

  it("leaves the ground as it was where no marked section is", () => {
    expect(groundUnder(sections, 2000)).toBeNull();
    expect(groundUnder([{ ground: "sepia", top: 0, bottom: 900 }], 500)).toBeNull();
  });
});
