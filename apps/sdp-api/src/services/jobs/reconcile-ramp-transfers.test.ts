import { SDP_RAMP_PROVIDER_STAGES } from "@sdp/types";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { replayRampWebhookEvents } from "@/services/jobs/replay-ramp-webhook-events";
import type { Env } from "@/types/env";
import { reconcileRampTransfers } from "./reconcile-ramp-transfers";

vi.mock("@/services/jobs/replay-ramp-webhook-events", () => ({
  replayRampWebhookEvents: vi.fn(async () => 0),
}));

describe("reconcileRampTransfers", () => {
  beforeEach(() => {
    vi.mocked(replayRampWebhookEvents).mockReset().mockResolvedValue(0);
  });

  it("replays stored ramp webhooks for the release channel's providers", async () => {
    const env = {} as Env;

    await reconcileRampTransfers(env);

    expect(replayRampWebhookEvents).toHaveBeenCalledExactlyOnceWith(env, SDP_RAMP_PROVIDER_STAGES);
  });

  it("surfaces a replay failure to the scheduler", async () => {
    vi.mocked(replayRampWebhookEvents).mockRejectedValue(new Error("ramp inbox down"));

    await expect(reconcileRampTransfers({} as Env)).rejects.toThrow("ramp inbox down");
  });
});
