import { describe, expect, it } from "vitest";
import { BoundedLruMap } from "./bounded-lru";

describe("BoundedLruMap", () => {
  it("evicts the least recently used entry beyond its capacity", () => {
    const map = new BoundedLruMap<string, number>(2);
    map.set("a", 1);
    map.set("b", 2);
    expect(map.get("a")).toBe(1);
    map.set("c", 3);

    expect(map.size).toBe(2);
    expect(map.get("b")).toBeUndefined();
    expect(map.get("a")).toBe(1);
    expect(map.get("c")).toBe(3);
  });

  it("refuses a capacity that is not a positive integer", () => {
    expect(() => new BoundedLruMap(0)).toThrow();
  });
});
