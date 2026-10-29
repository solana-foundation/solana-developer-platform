import { SDP_RAMP_PROVIDER_MATURITY } from "@sdp/types/release-channels";
import { replayRampWebhookEvents } from "@/services/jobs/replay-ramp-webhook-events";
import type { Env } from "@/types/env";

/**
 * The ramp transfer reconciliation list, run by the `reconcile-ramp-transfers` Cron Definition.
 * A ramp job added here runs wherever reconciliation runs.
 *
 * @param env - Process environment.
 * @returns Resolves once stored ramp webhooks have been replayed.
 */
export async function reconcileRampTransfers(env: Env): Promise<void> {
  await replayRampWebhookEvents(env, SDP_RAMP_PROVIDER_MATURITY);
}
