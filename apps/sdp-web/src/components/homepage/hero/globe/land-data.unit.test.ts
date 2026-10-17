import { describe, expect, it } from "vitest";
import { LAND } from "./land-data";

describe("LAND", () => {
  it("keeps the coast data unchanged", () => {
    expect(LAND).toHaveLength(177);
    expect(LAND.reduce((count, ring) => count + ring.length, 0)).toBe(10986);
    expect(LAND[0][0]).toEqual([-180, 68.98]);
    expect(LAND[LAND.length - 1].at(-1)).toEqual([53.52, 80.18]);
  });
});
