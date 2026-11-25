import { currentClusterScope } from "@sdp/rpc/scope";
import type { SdpEnvironment } from "@sdp/types/api-keys";
import type { Operation } from "@sdp/types/operations";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { currentDatabaseIdentity } from "@/db/identity";
import * as notifications from "@/db/operation-notifications";
import type { OperationClaim, OperationScope } from "@/db/repositories/operations.repository";
import type { BackgroundRunner } from "@/runtime/background";
import { getLogContext, getLogger } from "@/runtime/logger";
import * as moneyPathEvents from "@/runtime/money-path-events";
import * as operations from "@/services/operations.service";
import { deferred } from "@/test/helpers/deferred";
import { env } from "@/test/helpers/env";
import { required } from "@/test/helpers/required";
import { type OperationWorker, startOperationWorker } from "./operation-worker";
import * as recovery from "./reconcile-operations";

type ClaimedOperation = NonNullable<
  Awaited<ReturnType<operations.OperationsService["repository"]["claimNextRecovery"]>>
>;
type ListenerOptions = Parameters<typeof notifications.listenForOperationNotifications>[1];

function claimed(id: string, environment: SdpEnvironment = "sandbox"): ClaimedOperation {
  const scope: OperationScope = { organizationId: "org", projectId: "project", environment };
  const operation: Operation = {
    id,
    kind: "earn.deposit",
    status: "queued",
    environment,
    intent: {
      kind: "earn.deposit",
      strategyId: "strategy",
      source: { walletId: "wallet" },
      amount: { mint: "mint", value: "10" },
    },
    actionId: "action",
    version: 1,
    nextAction: { type: "wait", reason: "Execution queued" },
    terms: { expiresAt: null, estimate: null, minimum: null, fees: null, options: [] },
    buildRef: { kind: "earn.strategy_transaction", id: "build" },
    resourceRef: null,
    canCancel: false,
    result: null,
    cancelRequestedAt: null,
    error: null,
    createdAt: "2026-11-18T00:00:00.000Z",
    updatedAt: "2026-11-18T00:00:00.000Z",
  };
  const claim: OperationClaim = {
    operation,
    token: `claim-${id}`,
    fence: 1,
    purpose: "execute",
    recoveryRequired: false,
    attempt: {
      id: `attempt-${id}`,
      operationId: id,
      actionId: operation.actionId,
      version: operation.version,
      principal: { kind: "member", userId: "member" },
      buildRef: operation.buildRef,
      signedTransaction: null,
      signature: null,
      lastValidBlockHeight: null,
      dispatchStartedAt: null,
      executionRequestedAt: operation.createdAt,
      auditIntentId: "audit",
      observationOnly: false,
      proposalBinding: null,
      resourceRef: null,
    },
  };
  return { scope, claim };
}

function fixtures() {
  const service = operations.createOperationsService(env);
  vi.spyOn(operations, "createOperationsService").mockReturnValue(service);
  const claim = vi.spyOn(service.repository, "claimNextRecovery").mockResolvedValue(null);
  const release = vi.spyOn(service.repository, "release").mockResolvedValue(true);
  const execute = vi.spyOn(recovery, "recoverOperationClaim").mockResolvedValue(true);
  const logError = vi.spyOn(getLogger(), "error").mockImplementation(() => {});
  const logEvent = vi.spyOn(moneyPathEvents, "logEvent").mockImplementation(() => {});
  let options: ListenerOptions | undefined;
  const stopListener = vi.fn(async () => {});
  vi.spyOn(notifications, "listenForOperationNotifications").mockImplementation((_env, value) => {
    options = value;
    return { stop: stopListener };
  });
  const tasks: Promise<unknown>[] = [];
  const bg: BackgroundRunner = {
    run: (task) => {
      tasks.push(task);
    },
    awaitAll: async () => {
      await Promise.allSettled(tasks);
    },
    draining: false,
  };
  return {
    claim,
    release,
    execute,
    logError,
    logEvent,
    stopListener,
    bg,
    options: () => required(options),
  };
}

let mocks: ReturnType<typeof fixtures>;
let worker: OperationWorker | undefined;
const releaseGates: (() => void)[] = [];
beforeEach(() => {
  mocks = fixtures();
});
afterEach(async () => {
  for (const release of releaseGates.splice(0)) release();
  await worker?.stop();
  worker = undefined;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function start(environments: readonly SdpEnvironment[] = ["sandbox"]): OperationWorker {
  worker = startOperationWorker(env, mocks.bg, environments);
  return worker;
}

function gate() {
  const value = deferred<void>();
  releaseGates.push(() => value.resolve());
  return value;
}

describe("database-notified operation consumers", () => {
  it.each([
    { mode: "previous 15-second schedule", tickMs: 15_000, notify: false, delayMs: 14_999 },
    { mode: "lost notification fallback", tickMs: 2_000, notify: false, delayMs: 1_999 },
    { mode: "commit notification", tickMs: 2_000, notify: true, delayMs: 0 },
  ])("measures accepted-to-start delay with $mode", async ({ tickMs, notify, delayMs }) => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const consumer = start();
    const timer = setInterval(() => consumer.wake("sandbox"), tickMs);
    try {
      // A commit immediately after a tick exposes the timer's worst-case pickup wait.
      await vi.advanceTimersByTimeAsync(1);
      const acceptedAt = Date.now();
      const started: number[] = [];
      mocks.claim.mockResolvedValueOnce(claimed("accepted-after-tick"));
      mocks.execute.mockImplementation(async () => {
        started.push(Date.now() - acceptedAt);
        return true;
      });
      if (notify) mocks.options().wake("sandbox");
      await vi.advanceTimersByTimeAsync(delayMs);
      expect(started).toEqual([delayMs]);
    } finally {
      clearInterval(timer);
    }
  });

  it("shares only a brief authority-scoped observation batch between concurrent claims", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000);
    mocks.claim.mockResolvedValueOnce(claimed("first")).mockResolvedValueOnce(claimed("second"));
    const consumer = start();
    consumer.wake("sandbox");
    await mocks.bg.awaitAll();
    expect(mocks.execute).toHaveBeenCalledTimes(2);
    const firstObservation = mocks.execute.mock.calls[0]?.[3];
    expect(mocks.execute.mock.calls[1]?.[3]).toBe(firstObservation);
    clock.mockReturnValue(1_026);
    mocks.claim.mockResolvedValueOnce(claimed("later"));
    consumer.wake("sandbox");
    await mocks.bg.awaitAll();
    expect(mocks.execute.mock.calls[2]?.[3]).not.toBe(firstObservation);
  });

  it("fans commit, reconnect and scheduled wakes to the observer only for admitted environments", async () => {
    const wakeObserver = vi.fn();
    worker = startOperationWorker(env, mocks.bg, ["sandbox"], { wakeObserver });
    mocks.options().connected();
    mocks.options().wake("sandbox");
    worker.wake("sandbox");
    mocks.options().wake("production");
    await mocks.bg.awaitAll();
    expect(wakeObserver.mock.calls).toEqual([["sandbox"], ["sandbox"], ["sandbox"]]);
    await worker.stop();
    worker.wake("sandbox");
    expect(wakeObserver).toHaveBeenCalledTimes(3);
  });

  it("scans after LISTEN and reconnect, restoring only the worker entry identity", async () => {
    const next = claimed("accepted");
    mocks.claim.mockResolvedValueOnce(next);
    mocks.execute.mockImplementation(async (_env, scope, claim) => {
      expect(currentDatabaseIdentity()).toEqual({
        kind: "system",
        component: "cron:reconcile-operations",
      });
      expect(currentClusterScope()).toMatchObject({ projectId: null, environment: "sandbox" });
      expect(getLogContext().cron).toBe("reconcile-operations");
      expect(scope).toEqual(next.scope);
      expect(claim.attempt.principal).toEqual(next.claim.attempt.principal);
      return true;
    });
    start();
    expect(mocks.claim).not.toHaveBeenCalled();
    mocks.options().connected();
    await mocks.bg.awaitAll();
    expect(mocks.execute).toHaveBeenCalledTimes(1);
    const previous = mocks.claim.mock.calls.length;
    mocks.options().connected();
    await mocks.bg.awaitAll();
    expect(mocks.claim.mock.calls.length).toBeGreaterThan(previous);
  });

  it("lets scheduled wakes use free slots while a signer is blocked and notifications are down", async () => {
    const slow = gate();
    const first = claimed("slow");
    mocks.claim.mockResolvedValueOnce(first);
    mocks.execute.mockImplementation(async (_env, _scope, claim) => {
      if (claim.operation.id === "slow") await slow.promise;
      return true;
    });
    const consumer = start();
    expect(consumer.wake("sandbox")).toBeUndefined();
    await vi.waitFor(() => expect(mocks.execute).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(mocks.claim).toHaveBeenCalledTimes(4));
    // Model the next periodic recovery tick; it cannot await the blocked signer.
    mocks.claim.mockResolvedValueOnce(claimed("new"));
    expect(consumer.wake("sandbox")).toBeUndefined();
    await vi.waitFor(() => expect(mocks.execute).toHaveBeenCalledTimes(2));
    expect(mocks.execute.mock.calls[1]?.[2].operation.id).toBe("new");
    slow.resolve();
  });

  it("bounds each environment to four in-flight claims under notification storms", async () => {
    const blocked = gate();
    const due = Array.from({ length: 12 }, (_, index) => claimed(String(index)));
    mocks.claim.mockImplementation(async () => due.shift() ?? null);
    mocks.execute.mockImplementation(async () => {
      await blocked.promise;
      return true;
    });
    start();
    for (let index = 0; index < 100; index += 1) mocks.options().wake("sandbox");
    await vi.waitFor(() => expect(mocks.execute).toHaveBeenCalledTimes(4));
    expect(mocks.claim).toHaveBeenCalledTimes(4);
    blocked.resolve();
    await vi.waitFor(() => expect(mocks.execute).toHaveBeenCalledTimes(12));
    expect(new Set(mocks.execute.mock.calls.map((call) => call[2].operation.id)).size).toBe(12);
  });

  it("rescans a coalesced hint while all four empty claims are in flight", async () => {
    const empty = Array.from({ length: 4 }, () => deferred<ClaimedOperation | null>());
    for (const claim of empty) mocks.claim.mockReturnValueOnce(claim.promise);
    start();
    mocks.options().wake("sandbox");
    await vi.waitFor(() => expect(mocks.claim).toHaveBeenCalledTimes(4));
    mocks.claim.mockResolvedValueOnce(claimed("after-commit"));
    mocks.options().wake("sandbox");
    expect(mocks.claim).toHaveBeenCalledTimes(4);
    for (const claim of empty) claim.resolve(null);
    await vi.waitFor(() => expect(mocks.execute).toHaveBeenCalledTimes(1));
  });

  it("releases a claim acquired during shutdown without starting its action", async () => {
    const acquiring = deferred<ClaimedOperation | null>();
    const next = claimed("late-claim");
    mocks.claim.mockReturnValueOnce(acquiring.promise);
    const consumer = start();
    consumer.wake("sandbox");
    await vi.waitFor(() => expect(mocks.claim).toHaveBeenCalledTimes(4));
    const stopping = consumer.stop();
    acquiring.resolve(next);
    await stopping;
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(mocks.release).toHaveBeenCalledExactlyOnceWith(next.scope, next.claim);
  });

  it("leaves failed scans retryable by the next scheduled wake", async () => {
    mocks.claim.mockRejectedValueOnce(new Error("Database unavailable"));
    const consumer = start();
    consumer.wake("sandbox");
    await mocks.bg.awaitAll();
    mocks.claim.mockResolvedValueOnce(claimed("retry"));
    consumer.wake("sandbox");
    await mocks.bg.awaitAll();
    expect(mocks.execute).toHaveBeenCalledTimes(1);
    expect(mocks.logEvent).toHaveBeenCalledExactlyOnceWith("error", {
      event: "sdp_cron_run",
      cron: "reconcile-operations",
      environment: "sandbox",
      status: "error",
      monitor: "sdp-api-reconcile-operations",
      duration_ms: expect.any(Number),
      error_name: "Error",
    });
  });

  it("reports failed claimed actions to existing cron alerts while other work continues", async () => {
    mocks.claim.mockResolvedValueOnce(claimed("failed")).mockResolvedValueOnce(claimed("healthy"));
    mocks.execute.mockResolvedValueOnce(false);
    const consumer = start();
    expect(consumer.wake("sandbox")).toBeUndefined();
    await mocks.bg.awaitAll();
    expect(mocks.execute).toHaveBeenCalledTimes(2);
    expect(mocks.logEvent).toHaveBeenCalledExactlyOnceWith("error", {
      event: "sdp_cron_run",
      cron: "reconcile-operations",
      environment: "sandbox",
      status: "error",
      monitor: "sdp-api-reconcile-operations",
      duration_ms: expect.any(Number),
      error_name: "Error",
    });
    mocks.claim.mockResolvedValueOnce(claimed("next-tick"));
    expect(consumer.wake("sandbox")).toBeUndefined();
    await mocks.bg.awaitAll();
    expect(mocks.execute).toHaveBeenCalledTimes(3);
  });

  it("does not consume a hinted environment the worker does not admit", async () => {
    start(["sandbox"]);
    mocks.options().wake("production");
    await Promise.resolve();
    expect(mocks.claim).not.toHaveBeenCalled();
  });

  it("stops new claims and drains the current action before shutdown completes", async () => {
    const blocked = gate();
    mocks.claim.mockResolvedValueOnce(claimed("active"));
    mocks.execute.mockImplementation(async () => {
      await blocked.promise;
      return true;
    });
    const consumer = start();
    mocks.options().wake("sandbox");
    await vi.waitFor(() => expect(mocks.execute).toHaveBeenCalledTimes(1));
    const stopping = consumer.stop();
    let stopped = false;
    void stopping.then(() => {
      stopped = true;
    });
    const count = mocks.claim.mock.calls.length;
    mocks.options().wake("sandbox");
    await Promise.resolve();
    expect(mocks.claim).toHaveBeenCalledTimes(count);
    expect(stopped).toBe(false);
    blocked.resolve();
    await stopping;
    expect(stopped).toBe(true);
    expect(mocks.stopListener).toHaveBeenCalledTimes(1);
  });
});
