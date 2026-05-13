import { describe, expect, it } from "vitest";
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

  it("awaitAll snapshots in-flight work; tasks added after the call are not awaited", async () => {
    const bg = new NodeBackgroundRunner();
    let lateTaskDone = false;

    bg.run(new Promise<void>((resolve) => setTimeout(resolve, 1)));
    const draining = bg.awaitAll();
    // Add a task after awaitAll has been called
    bg.run(
      new Promise<void>((resolve) =>
        setTimeout(() => {
          lateTaskDone = true;
          resolve();
        }, 20)
      )
    );

    await draining;
    expect(lateTaskDone).toBe(false);
  });
});
