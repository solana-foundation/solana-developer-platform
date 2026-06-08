import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BackgroundRunner } from "@/runtime/background";
import type { Observability } from "@/runtime/observability";
import type { Env } from "@/types/env";
import { PENDING_TRANSFERS_CRON, runPendingTransfersReconciliation } from "./pending-transfers";
import {
  RECURRING_PAYMENTS_COLLECTION_CRON,
  runRecurringPaymentsCollection,
} from "./recurring-payments";
import { startCron } from "./runner";

const scheduleMock = vi.fn();
const stopMock = vi.fn();
const fakeTask = {
  id: "fake",
  stop: stopMock,
  start: vi.fn(),
  getStatus: vi.fn(),
  destroy: vi.fn(),
  execute: vi.fn(),
  getNextRun: vi.fn(),
  on: vi.fn(),
  off: vi.fn(),
  once: vi.fn(),
};

vi.mock("node-cron", () => ({
  schedule: (...args: unknown[]) => scheduleMock(...args),
}));

vi.mock("./pending-transfers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./pending-transfers")>();
  return {
    ...actual,
    runPendingTransfersReconciliation: vi.fn(),
  };
});

vi.mock("./recurring-payments", () => ({
  RECURRING_PAYMENTS_COLLECTION_CRON: "*/5 * * * *",
  runRecurringPaymentsCollection: vi.fn(),
}));

function makeBg(): BackgroundRunner {
  return { run: vi.fn(), awaitAll: vi.fn(async () => {}), draining: false };
}

function makeObservability(): Observability {
  return {
    captureException: vi.fn(),
    withScope: vi.fn(),
    withMonitor: vi.fn(),
  };
}

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    PAYMENTS_RECURRING_ENABLED: "true",
    PAYMENTS_RECURRING_COLLECTION_ENABLED: "true",
    ...overrides,
  } as Env;
}

describe("startCron", () => {
  beforeEach(() => {
    scheduleMock.mockReset();
    stopMock.mockReset();
    scheduleMock.mockReturnValue(fakeTask);
    vi.mocked(runPendingTransfersReconciliation).mockReset();
    vi.mocked(runRecurringPaymentsCollection).mockReset();
  });

  it("returns null and does not schedule when DISABLE_CRON=true", () => {
    const result = startCron({ env: { DISABLE_CRON: "true" } as Env, bg: makeBg() });
    expect(result).toBeNull();
    expect(scheduleMock).not.toHaveBeenCalled();
  });

  it("returns null and does not schedule when DISABLE_CRON=1", () => {
    const result = startCron({ env: { DISABLE_CRON: "1" } as Env, bg: makeBg() });
    expect(result).toBeNull();
    expect(scheduleMock).not.toHaveBeenCalled();
  });

  it("schedules pending transfers and recurring payments with their own cron expressions", () => {
    startCron({ env: makeEnv(), bg: makeBg() });
    expect(scheduleMock).toHaveBeenCalledTimes(2);
    expect(scheduleMock.mock.calls[0][0]).toBe(PENDING_TRANSFERS_CRON);
    expect(scheduleMock.mock.calls[1][0]).toBe(RECURRING_PAYMENTS_COLLECTION_CRON);
  });

  it("does not schedule recurring payments when collection is feature-disabled", () => {
    startCron({ env: {} as Env, bg: makeBg() });
    expect(scheduleMock).toHaveBeenCalledTimes(1);
    expect(scheduleMock.mock.calls[0][0]).toBe(PENDING_TRANSFERS_CRON);
  });

  it("schedules when DISABLE_CRON is set to a recognised falsy value ('false' / '0')", () => {
    startCron({ env: makeEnv({ DISABLE_CRON: "false" }), bg: makeBg() });
    startCron({ env: makeEnv({ DISABLE_CRON: "0" }), bg: makeBg() });
    expect(scheduleMock).toHaveBeenCalledTimes(4);
  });

  it("throws on an unrecognised DISABLE_CRON value to surface env typos", () => {
    expect(() => startCron({ env: { DISABLE_CRON: "treu" } as Env, bg: makeBg() })).toThrow(
      /Invalid DISABLE_CRON/
    );
    expect(() => startCron({ env: { DISABLE_CRON: "yes" } as Env, bg: makeBg() })).toThrow(
      /Invalid DISABLE_CRON/
    );
    expect(scheduleMock).not.toHaveBeenCalled();
  });

  it("normalises DISABLE_CRON case and surrounding whitespace", () => {
    const result = startCron({ env: { DISABLE_CRON: "  TRUE  " } as Env, bg: makeBg() });
    expect(result).toBeNull();
    expect(scheduleMock).not.toHaveBeenCalled();
  });

  it("throws on a blank DISABLE_CRON value rather than defaulting silently", () => {
    expect(() => startCron({ env: { DISABLE_CRON: "   " } as Env, bg: makeBg() })).toThrow(
      /Invalid DISABLE_CRON/
    );
    expect(scheduleMock).not.toHaveBeenCalled();
  });

  it("tick invokes runPendingTransfersReconciliation with the supplied deps", () => {
    const bg = makeBg();
    const env = makeEnv();
    const observability = makeObservability();
    startCron({ env, bg, observability });
    const pendingTick = scheduleMock.mock.calls[0][1] as () => void;
    const recurringTick = scheduleMock.mock.calls[1][1] as () => void;
    pendingTick();
    recurringTick();
    expect(runPendingTransfersReconciliation).toHaveBeenCalledWith({ env, bg, observability });
    expect(runRecurringPaymentsCollection).toHaveBeenCalledWith({ env, bg, observability });
  });

  it("tick passes observability=undefined through when caller did not supply one", () => {
    const bg = makeBg();
    const env = makeEnv();
    startCron({ env, bg });
    const pendingTick = scheduleMock.mock.calls[0][1] as () => void;
    const recurringTick = scheduleMock.mock.calls[1][1] as () => void;
    pendingTick();
    recurringTick();
    expect(runPendingTransfersReconciliation).toHaveBeenCalledWith({
      env,
      bg,
      observability: undefined,
    });
    expect(runRecurringPaymentsCollection).toHaveBeenCalledWith({
      env,
      bg,
      observability: undefined,
    });
  });

  it("tick is a no-op after stop() has been called, even if the scheduler fires once more", async () => {
    const handle = startCron({ env: makeEnv(), bg: makeBg() });
    await handle?.stop();
    const pendingTick = scheduleMock.mock.calls[0][1] as () => void;
    const recurringTick = scheduleMock.mock.calls[1][1] as () => void;
    pendingTick();
    recurringTick();
    expect(runPendingTransfersReconciliation).not.toHaveBeenCalled();
    expect(runRecurringPaymentsCollection).not.toHaveBeenCalled();
  });

  it("returned handle.stop() delegates to the underlying scheduled task", async () => {
    const handle = startCron({ env: makeEnv(), bg: makeBg() });
    expect(handle).not.toBeNull();
    await handle?.stop();
    expect(stopMock).toHaveBeenCalledTimes(2);
  });
});
