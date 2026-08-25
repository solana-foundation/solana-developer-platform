import { describe, expect, it } from "vitest";
import { waitForEgress } from "./egress-warmup";

describe("waitForEgress", () => {
  it("returns ready after the first successful probe", async () => {
    let calls = 0;
    const result = await waitForEgress({
      probe: async () => {
        calls += 1;
        if (calls < 3) throw new TypeError("fetch failed");
      },
      deadlineMs: 10_000,
      intervalMs: 0,
    });
    expect(result.ready).toBe(true);
    expect(calls).toBe(3);
  });

  it("gives up at the deadline and reports not ready", async () => {
    let calls = 0;
    const result = await waitForEgress({
      probe: async () => {
        calls += 1;
        await new Promise((resolve) => setTimeout(resolve, 30));
        throw new TypeError("fetch failed");
      },
      deadlineMs: 100,
      intervalMs: 0,
    });
    expect(result.ready).toBe(false);
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(result.elapsedMs).toBeGreaterThanOrEqual(100);
  });

  it("succeeds immediately when egress already works", async () => {
    const result = await waitForEgress({
      probe: async () => {},
      deadlineMs: 10_000,
      intervalMs: 1_000,
    });
    expect(result.ready).toBe(true);
    expect(result.elapsedMs).toBeLessThan(1_000);
  });
});
