/**
 * In-process API application used by tests and integration tooling.
 *
 * Production HTTP serving is owned by `server.ts`, which adds Node transport,
 * background-task draining, cron, and lifecycle management around the same
 * application factory.
 */

import { createApp } from "@/app";
import { nodeObservability } from "@/runtime/observability-node";

const app = createApp({ observability: nodeObservability });

export default app;
