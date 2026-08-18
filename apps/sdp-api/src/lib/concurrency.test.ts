import { describe, expect, it } from "vitest";
import { mapSettledWithConcurrency } from "./concurrency";

describe("mapSettledWithConcurrency", () => {
  it("never runs more mappers at once than the concurrency bound", async () => {
    let inFlight = 0;
    let peak = 0;
    const items = Array.from({ length: 20 }, (_, index) => index);

    await mapSettledWithConcurrency(items, 5, async (item) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return item;
    });

    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(5);
  });

  it("returns settled results in input order, isolating failures", async () => {
    const results = await mapSettledWithConcurrency([1, 2, 3, 4], 2, async (item) => {
      if (item % 2 === 0) {
        throw new Error(`boom ${item}`);
      }
      return item * 10;
    });

    expect(results).toEqual([
      { status: "fulfilled", value: 10 },
      { status: "rejected", reason: new Error("boom 2") },
      { status: "fulfilled", value: 30 },
      { status: "rejected", reason: new Error("boom 4") },
    ]);
  });

  it("handles an empty item list", async () => {
    await expect(mapSettledWithConcurrency([], 3, async (item) => item)).resolves.toEqual([]);
  });
});
