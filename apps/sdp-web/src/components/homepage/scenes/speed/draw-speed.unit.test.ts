import { describe, expect, it } from "vitest";
import { lanesFor, laneTop } from "./draw-speed";

describe("speed lanes layout", () => {
  it("races four rails and carries one payment in one-lane mode", () => {
    expect(lanesFor("race")).toHaveLength(4);
    expect(lanesFor("one")).toHaveLength(1);
  });

  it("spreads the race rails evenly from 18% to 82% of the box", () => {
    const tops = [0, 1, 2, 3].map((index) => laneTop("race", index, 4));

    expect(tops[0]).toBeCloseTo(0.18);
    expect(tops[3]).toBeCloseTo(0.82);
    expect(tops[1] - tops[0]).toBeCloseTo(tops[2] - tops[1]);
    expect(tops[2] - tops[1]).toBeCloseTo(tops[3] - tops[2]);
  });

  it("centres the single rail", () => {
    expect(laneTop("one", 0, 1)).toBe(0.5);
  });
});
