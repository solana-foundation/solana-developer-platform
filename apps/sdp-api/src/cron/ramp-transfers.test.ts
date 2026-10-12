import { describe, expect, it, vi } from "vitest";
import type { BackgroundRunner } from "@/runtime/background";
import type { Observability } from "@/runtime/observability";
import { reconcileRampTransfers } from "@/services/jobs/reconcile-ramp-transfers";
import type { Env } from "@/types/env";
import {
  RAMP_TRANSFERS_CRON,
  RAMP_TRANSFERS_MONITOR,
  runRampTransfersReconciliation,
} from "./ramp-transfers";

vi.mock("@/services/jobs/reconcile-ramp-transfers", () => ({
  reconcileRampTransfers: vi.fn(async () => {}),
}));

describe("runRampTransfersReconciliation", () => {
  it("runs the shared ramp list under its own monitor and hands the run to the background runner", async () => {
    const env = {} as Env;
    const bg: BackgroundRunner = { run: vi.fn(), awaitAll: vi.fn(async () => {}), draining: false };
    const observability: Observability = {
      captureException: vi.fn(),
      withScope: vi.fn(),
      withMonitor: vi.fn(),
    };
    vi.mocked(observability.withMonitor).mockImplementation((_slug, fn) => fn());

    runRampTransfersReconciliation({ env, bg, observability });
    await vi.mocked(bg.run).mock.calls[0]?.[0];

    expect(observability.withMonitor).toHaveBeenCalledExactlyOnceWith(
      RAMP_TRANSFERS_MONITOR,
      expect.any(Function),
      { schedule: { type: "crontab", value: RAMP_TRANSFERS_CRON } }
    );
    expect(reconcileRampTransfers).toHaveBeenCalledExactlyOnceWith(env);
  });
});
