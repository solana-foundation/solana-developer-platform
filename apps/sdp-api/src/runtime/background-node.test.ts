import { describe, expect, it, vi } from "vitest";
import { NodeBackgroundRunner } from "./background-node";

describe("NodeBackgroundRunner", () => {
  it("awaitAll resolves once all tracked promises settle", async () => {
    vi.useFakeTimers();
    try {
      const bg = new NodeBackgroundRunner();
      let aResolved = false;
      let bResolved = false;

      bg.run(
        new Promise<void>((resolve) =>
          setTimeout(() => {
            aResolved = true;
            resolve();
          }, 5)
        )
      );
      bg.run(
        new Promise<void>((resolve) =>
          setTimeout(() => {
            bResolved = true;
            resolve();
          }, 10)
        )
      );

      const drain = bg.awaitAll();
      await vi.advanceTimersByTimeAsync(10);
      await drain;

      expect(aResolved).toBe(true);
      expect(bResolved).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("awaitAll swallows rejections without throwing (matches CF waitUntil)", async () => {
    const bg = new NodeBackgroundRunner();
    bg.run(Promise.reject(new Error("boom")));
    bg.run(Promise.resolve("ok"));
    await expect(bg.awaitAll()).resolves.toBeUndefined();
  });

  it("after awaitAll() the runner is sealed — further run() calls are warned and not tracked", async () => {
    const bg = new NodeBackgroundRunner();
    bg.run(Promise.resolve());
    await bg.awaitAll();

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      bg.run(Promise.resolve());
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0]?.[0]).toContain("after awaitAll() completed");
      expect(warnSpy.mock.calls[0]?.[0]).toContain("not tracked");

      // Second awaitAll() on a sealed runner is a no-op — the new task wasn't
      // tracked, and the original pending set was cleared by the first drain.
      await bg.awaitAll();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("run() during awaitAll() drain warns and does not track the late task", async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const bg = new NodeBackgroundRunner();
      let lateTaskDone = false;

      bg.run(new Promise<void>((resolve) => setTimeout(resolve, 1)));
      const draining = bg.awaitAll();
      expect(bg.draining).toBe(true);
      // Adding a task after awaitAll has started — caller's side effects are
      // already in flight, but it is not tracked by the current drain.
      bg.run(
        new Promise<void>((resolve) =>
          setTimeout(() => {
            lateTaskDone = true;
            resolve();
          }, 20)
        )
      );
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0]?.[0]).toContain("during awaitAll() drain");
      expect(warnSpy.mock.calls[0]?.[0]).toContain("not tracked");

      // Advance just enough for the first task to fire — the late task's 20ms
      // timer stays pending, proving it isn't awaited by the drain.
      await vi.advanceTimersByTimeAsync(1);
      await draining;
      expect(bg.draining).toBe(false);
      expect(lateTaskDone).toBe(false);
    } finally {
      warnSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("untracked task rejection is surfaced via console.warn", async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const bg = new NodeBackgroundRunner();

      bg.run(new Promise<void>((resolve) => setTimeout(resolve, 1)));
      const draining = bg.awaitAll();
      bg.run(Promise.reject(new Error("late boom")));

      // Advance the first task's 1ms timer; advanceTimersByTimeAsync flushes
      // microtasks too, so the rejection-logging .catch handler fires.
      await vi.advanceTimersByTimeAsync(1);
      await draining;

      // Two warns: one at registration (drain guard), one for the rejection.
      expect(warnSpy).toHaveBeenCalledTimes(2);
      expect(warnSpy.mock.calls[1]?.[0]).toContain("untracked task rejected");
    } finally {
      warnSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("concurrent awaitAll() calls refcount so draining stays true until the last", async () => {
    vi.useFakeTimers();
    try {
      const bg = new NodeBackgroundRunner();
      bg.run(new Promise<void>((resolve) => setTimeout(resolve, 10)));

      const drain1 = bg.awaitAll();
      const drain2 = bg.awaitAll();
      expect(bg.draining).toBe(true);

      await vi.advanceTimersByTimeAsync(10);
      await Promise.all([drain1, drain2]);
      expect(bg.draining).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejecting task fired during normal runtime does not emit unhandledRejection", async () => {
    const bg = new NodeBackgroundRunner();
    const captured: unknown[] = [];
    const listener = (reason: unknown) => captured.push(reason);
    process.on("unhandledRejection", listener);
    try {
      bg.run(Promise.reject(new Error("late boom")));
      // Give Node's microtask + unhandledRejection queues time to drain.
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(captured).toEqual([]);
    } finally {
      process.off("unhandledRejection", listener);
    }
  });
});
