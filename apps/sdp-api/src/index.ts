/**
 * In-process API application used by tests and integration tooling.
 *
 * Production HTTP serving is owned by `server.ts`, which adds Node transport,
 * background-task draining, cron, and lifecycle management around the same
 * application factory.
 */

import { SDP_RAMP_PROVIDER_STAGES } from "@sdp/types";
import { createApp } from "@/app";
import { noopObservability } from "@/runtime/observability";

const app = createApp({
  observability: noopObservability,
  rampProviderStages: SDP_RAMP_PROVIDER_STAGES,
});

export default app;
