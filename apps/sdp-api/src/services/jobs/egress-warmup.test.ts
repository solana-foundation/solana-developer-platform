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
      stopSignal: new AbortController().signal,
    });
    expect(result.outcome).toBe("ready");
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
      stopSignal: new AbortController().signal,
    });
    expect(result.outcome).toBe("deadline");
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(result.elapsedMs).toBeGreaterThanOrEqual(100);
  });

  it("succeeds immediately when egress already works", async () => {
    const result = await waitForEgress({
      probe: async () => {},
      deadlineMs: 10_000,
      intervalMs: 1_000,
      stopSignal: new AbortController().signal,
    });
    expect(result.outcome).toBe("ready");
    expect(result.elapsedMs).toBeLessThan(1_000);
  });

  it("returns stopped without waiting out the interval when the stop signal aborts mid-sleep", async () => {
    const stop = new AbortController();
    let calls = 0;
    const waiting = waitForEgress({
      probe: async () => {
        calls += 1;
        throw new TypeError("fetch failed");
      },
      deadlineMs: 600_000,
      intervalMs: 600_000,
      stopSignal: stop.signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    stop.abort();

    const result = await waiting;

    expect(calls).toBe(1);
    expect(result).toEqual({ outcome: "stopped", elapsedMs: expect.any(Number), attempts: 1 });
    expect(result.elapsedMs).toBeLessThan(1_000);
  });
});
