import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as cronEvents from "@/cron/run-event";
import type { BackgroundRunner } from "@/runtime/background";
import { deferred } from "@/test/helpers/deferred";
import { env } from "@/test/helpers/env";
import { startEarnTransactionObserver } from "./earn-transaction-observer";
import * as observation from "./observe-earn-transactions";

let observer: ReturnType<typeof startEarnTransactionObserver> | undefined;
const gates: Array<() => void> = [];
const tasks: Promise<unknown>[] = [];
const bg: BackgroundRunner = {
  draining: false,
  run: (task) => {
    tasks.push(task);
  },
  awaitAll: async () => {
    await Promise.allSettled(tasks);
  },
};

beforeEach(() => {
  tasks.length = 0;
});
afterEach(async () => {
  for (const release of gates.splice(0)) release();
  await observer?.stop();
  observer = undefined;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function start() {
  observer = startEarnTransactionObserver(bg, ["sandbox"], () =>
    observation.observeEarnTransactions(env)
  );
  return observer;
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("Earn observation wakeups", () => {
  it("starts immediately and does not wait for a cron boundary", async () => {
    vi.useFakeTimers();
    const observedAt: number[] = [];
    const startAt = Date.now();
    const read = vi.spyOn(observation, "observeEarnTransactions").mockImplementation(async () => {
      observedAt.push(Date.now() - startAt);
      return { scanned: 0, saturated: false };
    });
    const worker = start();
    worker.wake("production");
    expect(read).not.toHaveBeenCalled();
    worker.wake("sandbox");
    await flush();
    expect(observedAt).toEqual([0]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("accepts a new wake while a provider holds another batch, with at most two batches", async () => {
    const slow = deferred<{ scanned: number; saturated: boolean }>();
    gates.push(() => slow.resolve({ scanned: 0, saturated: false }));
    const read = vi
      .spyOn(observation, "observeEarnTransactions")
      .mockImplementationOnce(() => slow.promise)
      .mockResolvedValue({ scanned: 0, saturated: false });
    const worker = start();
    worker.wake("sandbox");
    expect(read).toHaveBeenCalledTimes(1);
    worker.wake("sandbox");
    expect(read).toHaveBeenCalledTimes(2);
    await flush();
    expect(tasks).toHaveLength(2);
  });

  it("retains a wake arriving when both batches are busy", async () => {
    vi.useFakeTimers();
    const slow = deferred<{ scanned: number; saturated: boolean }>();
    gates.push(() => slow.resolve({ scanned: 0, saturated: false }));
    const read = vi
      .spyOn(observation, "observeEarnTransactions")
      .mockImplementationOnce(() => slow.promise)
      .mockImplementationOnce(() => slow.promise)
      .mockResolvedValue({ scanned: 0, saturated: false });
    const worker = start();
    worker.wake("sandbox");
    worker.wake("sandbox");
    worker.wake("sandbox");
    expect(read).toHaveBeenCalledTimes(2);
    slow.resolve({ scanned: 0, saturated: false });
    await flush();
    await vi.advanceTimersByTimeAsync(0);
    expect(read).toHaveBeenCalledTimes(3);
  });

  it("checks active work after 250ms, drains full batches immediately, and stops when empty", async () => {
    vi.useFakeTimers();
    const read = vi
      .spyOn(observation, "observeEarnTransactions")
      .mockResolvedValueOnce({ scanned: 64, saturated: true })
      .mockResolvedValueOnce({ scanned: 1, saturated: false })
      .mockResolvedValue({ scanned: 0, saturated: false });
    start().wake("sandbox");
    await flush();
    await vi.advanceTimersByTimeAsync(0);
    expect(read).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(249);
    expect(read).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(read).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(read).toHaveBeenCalledTimes(3);
  });

  it("keeps draining a full page containing only retired observation hints", async () => {
    vi.useFakeTimers();
    const read = vi
      .spyOn(observation, "observeEarnTransactions")
      .mockResolvedValueOnce({ scanned: 0, saturated: true })
      .mockResolvedValueOnce({ scanned: 1, saturated: false })
      .mockResolvedValue({ scanned: 0, saturated: false });
    start().wake("sandbox");
    await flush();
    await vi.advanceTimersByTimeAsync(0);
    expect(read).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(250);
    expect(read).toHaveBeenCalledTimes(3);
  });

  it("retains the 250ms cadence after an exactly full pending batch drains", async () => {
    vi.useFakeTimers();
    const read = vi
      .spyOn(observation, "observeEarnTransactions")
      .mockResolvedValueOnce({ scanned: 64, saturated: true })
      .mockResolvedValueOnce({ scanned: 0, saturated: false })
      .mockResolvedValueOnce({ scanned: 64, saturated: true })
      .mockResolvedValue({ scanned: 0, saturated: false });
    start().wake("sandbox");
    await flush();
    await vi.advanceTimersByTimeAsync(0);
    expect(read).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(250);
    expect(read).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(read).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(250);
    expect(read).toHaveBeenCalledTimes(5);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(read).toHaveBeenCalledTimes(5);
  });

  it("reports observation failures and retries without treating the wake as successful work", async () => {
    vi.useFakeTimers();
    const error = new Error("RPC unavailable");
    const log = vi.spyOn(cronEvents, "logCronRun").mockImplementation(() => {});
    const read = vi
      .spyOn(observation, "observeEarnTransactions")
      .mockRejectedValueOnce(error)
      .mockResolvedValue({ scanned: 0, saturated: false });
    start().wake("sandbox");
    await flush();
    expect(log).toHaveBeenCalledWith(
      { cron: "earn-transaction-observer", environment: "sandbox", worker: "observer" },
      { status: "error", durationMs: 0, cause: error }
    );
    await vi.advanceTimersByTimeAsync(2_000);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("drains running work and cancels future observations on shutdown", async () => {
    vi.useFakeTimers();
    const read = vi
      .spyOn(observation, "observeEarnTransactions")
      .mockResolvedValue({ scanned: 1, saturated: false });
    const worker = start();
    worker.wake("sandbox");
    await flush();
    await worker.stop();
    worker.wake("sandbox");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(read).toHaveBeenCalledTimes(1);
  });
});
