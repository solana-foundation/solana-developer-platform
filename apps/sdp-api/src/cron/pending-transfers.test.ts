import { SDP_ENVIRONMENTS } from "@sdp/types";
import { describe, expect, it, vi } from "vitest";
import type { BackgroundRunner } from "@/runtime/background";
import { reconcileSponsorshipBudgets } from "@/services/jobs/reconcile-sponsorship-budgets";
import { replayRampWebhookEvents } from "@/services/jobs/replay-ramp-webhook-events";
import { trackPendingTransfers } from "@/services/jobs/track-pending-transfers";
import type { Env } from "@/types/env";
import { runPendingTransfersReconciliation } from "./pending-transfers";

vi.mock("@/services/jobs/track-pending-transfers", () => ({
  trackPendingTransfers: vi.fn(async () => {}),
}));

vi.mock("@/services/jobs/reconcile-sponsorship-budgets", () => ({
  reconcileSponsorshipBudgets: vi.fn(async () => {}),
}));

vi.mock("@/services/jobs/replay-ramp-webhook-events", () => ({
  replayRampWebhookEvents: vi.fn(async () => 0),
}));

describe("runPendingTransfersReconciliation", () => {
  // Replay belongs to the shared ramp list (cron/ramp-transfers.ts) that both
  // schedulers run; running it here too would double it on the worker.
  it("leaves ramp webhook replay to the shared ramp list", async () => {
    const env = {} as Env;
    const bg: BackgroundRunner = { run: vi.fn(), awaitAll: vi.fn(async () => {}), draining: false };

    runPendingTransfersReconciliation({ env, bg });
    await vi.mocked(bg.run).mock.calls[0]?.[0];

    expect(vi.mocked(trackPendingTransfers).mock.calls).toEqual(SDP_ENVIRONMENTS.map(() => [env]));
    expect(reconcileSponsorshipBudgets).toHaveBeenCalledExactlyOnceWith(env);
    expect(replayRampWebhookEvents).not.toHaveBeenCalled();
  });
});
