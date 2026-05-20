/**
 * SDP API — Node.js entrypoint.
 *
 * Mirrors `index.ts` (the Cloudflare entrypoint) but consumes the Node
 * runtime impls: `@hono/node-server` for HTTP, `node-cron` for the
 * reconciliation tick, `@sentry/node` for monitoring, `NodeBackgroundRunner`
 * for tracking fire-and-forget work that needs to survive past response.
 *
 * The shutdown sequence lives in `runtime/shutdown-node.ts`.
 */

import { pathToFileURL } from "node:url";
import { type ServerType, serve } from "@hono/node-server";

import { createApp } from "@/app";
import { startCron } from "@/cron/runner";
import { withProcessEnvFallback } from "@/lib/runtime-env";
import { NodeBackgroundRunner } from "@/runtime/background-node";
import { getSentryOptions, isSentryEnabled } from "@/runtime/observability";
import { initNodeSentry, nodeObservability } from "@/runtime/observability-node";
import { shutdown } from "@/runtime/shutdown-node";
import type { Env } from "@/types/env";

const DEFAULT_PORT = 8787;

function resolvePort(): number {
  const raw = process.env.PORT;
  if (!raw) {
    return DEFAULT_PORT;
  }
  // `Number()` rejects trailing garbage by returning NaN ("8787abc" -> NaN),
  // unlike `Number.parseInt` which would silently truncate to 8787.
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
    throw new Error(`Invalid PORT: ${raw}`);
  }
  return parsed;
}

function assertRequiredEnv(env: Env): void {
  if (!env.ENVIRONMENT) {
    throw new Error("ENVIRONMENT is required (set to 'development' or 'production')");
  }
  if (!env.API_VERSION) {
    throw new Error("API_VERSION is required");
  }
  if (!env.DATABASE_URL?.trim()) {
    throw new Error("DATABASE_URL is required for the Node runtime");
  }
  if (!env.REDIS_URL?.trim()) {
    throw new Error("REDIS_URL is required for the Node runtime");
  }
}

async function main(): Promise<void> {
  // The Node entrypoint IS the Node runtime — don't let a stray process.env
  // value flip the KV factory back to Cloudflare mode. Set this before
  // assertRequiredEnv so downstream code (e.g. getRuntime) sees the override.
  const env = withProcessEnvFallback({} as Env);
  env.SDP_RUNTIME = "node";
  assertRequiredEnv(env);

  initNodeSentry(getSentryOptions(env));

  const app = createApp({ observability: nodeObservability });
  const bg = new NodeBackgroundRunner();
  const cron = startCron({
    env,
    bg,
    observability: isSentryEnabled(env) ? nodeObservability : undefined,
  });

  const port = resolvePort();
  const server: ServerType = serve({
    fetch: (req) => app.fetch(req, env),
    port,
  });

  console.log(`sdp-api listening on :${port}`);

  let shuttingDown: Promise<void> | null = null;
  const beginShutdown = (label: string): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = shutdown({
      server,
      cron,
      bg,
      log: (msg) => console.log(`[${label}] ${msg}`),
    })
      .then(() => {
        process.exit(0);
      })
      .catch((err: unknown) => {
        console.error("Shutdown failed:", err);
        process.exit(1);
      });
  };

  process.on("SIGTERM", () => beginShutdown("SIGTERM"));
  process.on("SIGINT", () => beginShutdown("SIGINT"));

  // Unhandled rejections in routes or background tasks are recoverable —
  // log them and drain in-flight work through the normal shutdown path so
  // we don't leak Redis sockets or skip db pool cleanup. uncaughtException
  // is treated as fatal: V8 documents the process state as potentially
  // corrupted, so we log and exit fast rather than risk a hung shutdown;
  // the container orchestrator will restart a clean process.
  process.on("unhandledRejection", (reason) => {
    console.error("Unhandled rejection — initiating shutdown:", reason);
    beginShutdown("unhandledRejection");
  });
  process.on("uncaughtException", (err) => {
    console.error("Uncaught exception — exiting:", err);
    process.exit(1);
  });
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  main().catch((err: unknown) => {
    console.error("Fatal startup error:", err);
    process.exit(1);
  });
}
