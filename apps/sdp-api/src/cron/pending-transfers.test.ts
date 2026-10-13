import { SDP_RAMP_PROVIDER_STAGES } from "@sdp/types";
import { describe, expect, it, vi } from "vitest";
import type { BackgroundRunner } from "@/runtime/background";
import { reconcileBvnkOnrampPayouts } from "@/services/jobs/reconcile-bvnk-onramp-payouts";
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

vi.mock("@/services/jobs/reconcile-bvnk-onramp-payouts", () => ({
  reconcileBvnkOnrampPayouts: vi.fn(async () => {}),
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

    expect(trackPendingTransfers).toHaveBeenCalledExactlyOnceWith(env);
    expect(reconcileSponsorshipBudgets).toHaveBeenCalledExactlyOnceWith(env);
    expect(reconcileBvnkOnrampPayouts).toHaveBeenCalledExactlyOnceWith(
      env,
      SDP_RAMP_PROVIDER_STAGES
    );
    expect(replayRampWebhookEvents).not.toHaveBeenCalled();
  });
});
