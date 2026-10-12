import { SDP_RAMP_PROVIDER_STAGES } from "@sdp/types";
import { replayRampWebhookEvents } from "@/services/jobs/replay-ramp-webhook-events";
import type { Env } from "@/types/env";

/**
 * The ramp transfer reconciliation list, run by both schedulers: the
 * in-process cron (cron/ramp-transfers.ts) and the managed reconciliation job
 * (job.ts). A ramp job added here runs wherever reconciliation runs.
 */
export async function reconcileRampTransfers(env: Env): Promise<void> {
  await replayRampWebhookEvents(env, SDP_RAMP_PROVIDER_STAGES);
}
