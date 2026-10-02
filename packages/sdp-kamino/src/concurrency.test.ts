import { describe, expect, it, vi } from "vitest";
import { KAMINO_POSITION_READ_CONCURRENCY, mapSettledWithConcurrency } from "./concurrency";

describe("mapSettledWithConcurrency", () => {
  it("never runs more than the bound at once and settles every item", async () => {
    let active = 0;
    let maxActive = 0;
    const releases: Array<() => void> = [];
    const pending = mapSettledWithConcurrency(
      Array.from({ length: 9 }, (_, index) => index),
      KAMINO_POSITION_READ_CONCURRENCY,
      () => undefined,
      async (item) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise<void>((resolve) => releases.push(resolve));
        active -= 1;
        if (item === 4) throw new Error("item 4 failed");
        return item;
      }
    );

    for (const wave of [4, 4, 1]) {
      await vi.waitFor(() => expect(releases).toHaveLength(wave));
      for (const release of releases.splice(0)) release();
    }

    const results = await pending;
    expect(maxActive).toBe(KAMINO_POSITION_READ_CONCURRENCY);
    expect(results.map((result) => result.status)).toEqual([
      "fulfilled",
      "fulfilled",
      "fulfilled",
      "fulfilled",
      "rejected",
      "fulfilled",
      "fulfilled",
      "fulfilled",
      "fulfilled",
    ]);
  });

  it("does not dequeue another item after the operation expires", async () => {
    let expired = false;
    const releases: Array<() => void> = [];
    const mapper = vi.fn(() => new Promise<void>((resolve) => releases.push(resolve)));
    const pending = mapSettledWithConcurrency(
      Array.from({ length: 9 }, (_, index) => index),
      KAMINO_POSITION_READ_CONCURRENCY,
      () => {
        if (expired) throw new Error("vault operation expired");
      },
      mapper
    );
    await vi.waitFor(() => expect(mapper).toHaveBeenCalledTimes(KAMINO_POSITION_READ_CONCURRENCY));

    expired = true;
    for (const release of releases.splice(0)) release();

    await expect(pending).rejects.toThrow("vault operation expired");
    expect(mapper).toHaveBeenCalledTimes(KAMINO_POSITION_READ_CONCURRENCY);
  });
});
