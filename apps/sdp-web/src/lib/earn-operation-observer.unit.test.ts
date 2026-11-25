import type { Operation } from "@sdp/types/operations";
import { afterEach, expect, it, vi } from "vitest";
import { EarnApiError } from "./earn-client";
import { EarnOperationObserver } from "./earn-operation-observer";

function operation(id: string, status: Operation["status"] = "queued"): Operation {
  return {
    id,
    status,
    kind: "earn.deposit",
    environment: "sandbox",
    actionId: "action",
    version: 1,
    intent: {
      kind: "earn.deposit",
      strategyId: "strategy",
      source: { walletId: "wallet" },
      amount: { mint: "mint", value: "1" },
    },
    terms: { expiresAt: null, estimate: null, minimum: null, fees: null, options: [] },
    nextAction: null,
    buildRef: null,
    resourceRef: null,
    result: null,
    canCancel: false,
    cancelRequestedAt: null,
    error: null,
    createdAt: "2026-11-24T00:00:00Z",
    updatedAt: "2026-11-24T00:00:00Z",
  };
}

function createObserver(read: (ids: readonly string[]) => Promise<readonly Operation[]>) {
  const publish = vi.fn(async (_operations: readonly Operation[]) => {});
  const reportError = vi.fn(async (_error: Error | undefined) => {});
  const visible = vi.fn(() => true);
  const observer = new EarnOperationObserver({ read, publish, reportError, visible });
  return { observer, publish, reportError, visible };
}

afterEach(() => vi.useRealTimers());

it("caps recovery at one 100-operation batch per second and fairly drains 350 old rows", async () => {
  vi.useFakeTimers();
  const read = vi.fn(async (ids: readonly string[]) => ids.map((id) => operation(id, "completed")));
  const { observer, publish } = createObserver(read);
  const release = observer.retain();
  observer.recover(Array.from({ length: 350 }, (_, i) => `old-${i}`));
  await vi.advanceTimersByTimeAsync(4_000);
  expect(read.mock.calls.map(([ids]) => ids.length)).toEqual([100, 100, 100, 50]);
  expect(publish.mock.calls.flatMap(([operations]) => operations)).toHaveLength(350);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(read).toHaveBeenCalledTimes(4);
  release();
});

it("never overlaps a slow batch and publishes after the initiating dialog closes", async () => {
  vi.useFakeTimers();
  let finish: (operations: readonly Operation[]) => void = () => {};
  const read = vi.fn(
    () =>
      new Promise<readonly Operation[]>((resolve) => {
        finish = resolve;
      })
  );
  const { observer, publish } = createObserver(read);
  const closeFeed = observer.retain();
  const closeDialog = observer.retain();
  observer.recordObservation(operation("recent"), true);
  await vi.advanceTimersByTimeAsync(1_000);
  closeDialog();
  await vi.advanceTimersByTimeAsync(30_000);
  expect(read).toHaveBeenCalledTimes(1);
  finish([operation("recent", "completed")]);
  await vi.advanceTimersByTimeAsync(0);
  expect(publish).toHaveBeenCalledExactlyOnceWith([operation("recent", "completed")]);
  closeFeed();
});

it("backs off failures, honors Retry-After, and keeps the previous observation", async () => {
  vi.useFakeTimers();
  const read = vi
    .fn<(ids: readonly string[]) => Promise<readonly Operation[]>>()
    .mockRejectedValueOnce(new EarnApiError(429, undefined, "Busy", 10))
    .mockResolvedValue([operation("recent", "completed")]);
  const { observer, publish, reportError } = createObserver(read);
  const release = observer.retain();
  observer.recordObservation(operation("recent"), true);
  await vi.advanceTimersByTimeAsync(10_999);
  expect(read).toHaveBeenCalledTimes(1);
  expect(publish).not.toHaveBeenCalled();
  expect(reportError.mock.calls[0]?.[0]).toBeInstanceOf(EarnApiError);
  await vi.advanceTimersByTimeAsync(1);
  expect(read).toHaveBeenCalledTimes(2);
  expect(publish).toHaveBeenCalledTimes(1);
  expect(reportError).toHaveBeenLastCalledWith(undefined);
  release();
});

it("slows long custody waits and stops provider waits without forgetting newly opened work", async () => {
  vi.useFakeTimers();
  const read = vi.fn(async (ids: readonly string[]) =>
    ids.map((id) => operation(id, "awaiting_signature"))
  );
  const { observer } = createObserver(read);
  const close = observer.retain();
  observer.recordObservation(operation("recent"), true);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(read).toHaveBeenCalledTimes(30);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(read).toHaveBeenCalledTimes(32);
  observer.recordObservation(operation("recent", "settling"));
  await vi.advanceTimersByTimeAsync(30_000);
  expect(read).toHaveBeenCalledTimes(32);
  close();
  const reopen = observer.retain();
  observer.recordObservation(operation("new"), true);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(read).toHaveBeenLastCalledWith(["new"]);
  reopen();
});

it("does no hidden-page work and never publishes into an abandoned project cache", async () => {
  vi.useFakeTimers();
  let finish: (operations: readonly Operation[]) => void = () => {};
  const read = vi.fn(
    () =>
      new Promise<readonly Operation[]>((resolve) => {
        finish = resolve;
      })
  );
  const { observer, publish, visible } = createObserver(read);
  const leave = observer.retain();
  observer.recordObservation(operation("recent"), true);
  visible.mockReturnValue(false);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(read).not.toHaveBeenCalled();
  visible.mockReturnValue(true);
  await vi.advanceTimersByTimeAsync(1_000);
  leave();
  finish([operation("recent", "completed")]);
  await vi.advanceTimersByTimeAsync(0);
  expect(publish).not.toHaveBeenCalled();
});

it("publishes healthy operations when another requested row becomes unreadable", async () => {
  vi.useFakeTimers();
  const read = vi.fn(async (ids: readonly string[]) =>
    ids.filter((id) => id !== "revoked").map((id) => operation(id, "completed"))
  );
  const { observer, publish, reportError } = createObserver(read);
  const release = observer.retain();
  observer.recover(["revoked", "healthy"]);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(publish).toHaveBeenCalledExactlyOnceWith([operation("healthy", "completed")]);
  expect(reportError.mock.calls[0]?.[0]).toBeInstanceOf(Error);
  await vi.advanceTimersByTimeAsync(2_000);
  expect(read).toHaveBeenLastCalledWith(["revoked"]);
  expect(read).toHaveBeenCalledTimes(2);
  release();
});

it("restores fast observation when the same long-running operation is reopened", async () => {
  vi.useFakeTimers();
  const read = vi.fn(async (ids: readonly string[]) => ids.map((id) => operation(id)));
  const { observer } = createObserver(read);
  const close = observer.retain();
  observer.recordObservation(operation("recent"), true);
  await vi.advanceTimersByTimeAsync(32_000);
  expect(read).toHaveBeenCalledTimes(30);
  observer.focus("recent");
  await vi.advanceTimersByTimeAsync(1_000);
  expect(read).toHaveBeenCalledTimes(31);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(read).toHaveBeenCalledTimes(32);
  close();
});
