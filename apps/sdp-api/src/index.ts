/**
 * In-process API application used by tests and integration tooling.
 *
 * Production HTTP serving is owned by `server.ts`, which adds Node transport,
 * background-task draining, cron, and lifecycle management around the same
 * application factory.
 */

import { SDP_RAMP_PROVIDER_MATURITY } from "@sdp/types/release-channels";
import { createApp } from "@/app";

export const app = createApp({
  rampProviderMaturity: SDP_RAMP_PROVIDER_MATURITY,
});
