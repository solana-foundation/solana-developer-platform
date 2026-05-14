import { describe, expect, it, vi } from "vitest";
import { NodeBackgroundRunner } from "./background-node";

describe("NodeBackgroundRunner", () => {
  it("awaitAll resolves once all tracked promises settle", async () => {
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

    await bg.awaitAll();

    expect(aResolved).toBe(true);
    expect(bResolved).toBe(true);
  });

  it("awaitAll swallows rejections without throwing (matches CF waitUntil)", async () => {
    const bg = new NodeBackgroundRunner();
    bg.run(Promise.reject(new Error("boom")));
    bg.run(Promise.resolve("ok"));
    await expect(bg.awaitAll()).resolves.toBeUndefined();
  });

  it("settled promises are released from tracking", async () => {
    const bg = new NodeBackgroundRunner();
    bg.run(Promise.resolve());
    bg.run(Promise.resolve());
    await bg.awaitAll();
    // No good direct way to assert empty Set without exposing internals;
    // a second awaitAll should be instantaneous and the runner should be
    // reusable for new work.
    let secondRoundDone = false;
    bg.run(
      new Promise<void>((resolve) =>
        setTimeout(() => {
          secondRoundDone = true;
          resolve();
        }, 1)
      )
    );
    await bg.awaitAll();
    expect(secondRoundDone).toBe(true);
  });

  it("run() during awaitAll() drain warns and does not track the late task", async () => {
    const bg = new NodeBackgroundRunner();
    let lateTaskDone = false;
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
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
      expect(warnSpy.mock.calls[0]?.[0]).toContain("not tracked");

      await draining;
      expect(bg.draining).toBe(false);
      expect(lateTaskDone).toBe(false);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("untracked post-drain task rejection is surfaced via console.warn", async () => {
    const bg = new NodeBackgroundRunner();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      bg.run(new Promise<void>((resolve) => setTimeout(resolve, 1)));
      const draining = bg.awaitAll();
      bg.run(Promise.reject(new Error("late boom")));
      await draining;
      // Give the rejection-logging .catch handler a tick to fire.
      await new Promise((resolve) => setTimeout(resolve, 5));

      // Two warns: one at registration (drain guard), one for the rejection.
      expect(warnSpy).toHaveBeenCalledTimes(2);
      expect(warnSpy.mock.calls[1]?.[0]).toContain("untracked post-drain task rejected");
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("concurrent awaitAll() calls refcount so draining stays true until the last", async () => {
    const bg = new NodeBackgroundRunner();
    bg.run(new Promise<void>((resolve) => setTimeout(resolve, 10)));

    const drain1 = bg.awaitAll();
    const drain2 = bg.awaitAll();
    expect(bg.draining).toBe(true);

    await Promise.all([drain1, drain2]);
    expect(bg.draining).toBe(false);
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
