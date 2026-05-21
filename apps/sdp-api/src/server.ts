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
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 25_000;
const TRUTHY_ENV: ReadonlySet<string> = new Set(["true", "1"]);
const FALSY_ENV: ReadonlySet<string> = new Set(["false", "0"]);

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

function resolveShutdownTimeoutMs(): number {
  const raw = process.env.SHUTDOWN_TIMEOUT_MS;
  if (raw === undefined) {
    return DEFAULT_SHUTDOWN_TIMEOUT_MS;
  }
  // SHUTDOWN_TIMEOUT_MS="" likely means a deploy script tried to set it
  // and produced an empty string by accident; treat it as a typo rather
  // than silently using the default.
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid SHUTDOWN_TIMEOUT_MS: ${JSON.stringify(raw)}`);
  }
  return parsed;
}

function shouldShutdownOnUnhandledRejection(): boolean {
  const raw = process.env.FATAL_ON_UNHANDLED_REJECTION;
  if (raw === undefined) {
    return true;
  }
  // Case-insensitive on purpose: env vars are commonly assembled by
  // shells, k8s manifests, and .env loaders that don't normalise case,
  // so "True"/"FALSE" should behave like "true"/"false".
  const normalised = raw.trim().toLowerCase();
  if (normalised === "") {
    throw new Error(`Invalid FATAL_ON_UNHANDLED_REJECTION: ${JSON.stringify(raw)}`);
  }
  if (TRUTHY_ENV.has(normalised)) {
    return true;
  }
  if (FALSY_ENV.has(normalised)) {
    return false;
  }
  throw new Error(`Invalid FATAL_ON_UNHANDLED_REJECTION: ${JSON.stringify(raw)}`);
}

// Runtime whitelist so a typo (`ENVIRONMENT=prod`) can't slip past the type
// and reach branches that gate dev-only behaviour on `ENVIRONMENT === "production"`.
const ALLOWED_ENVIRONMENTS: ReadonlySet<string> = new Set(["development", "production"]);

function assertRequiredEnv(env: Env): void {
  if (!env.ENVIRONMENT) {
    throw new Error("ENVIRONMENT is required (set to 'development' or 'production')");
  }
  if (!ALLOWED_ENVIRONMENTS.has(env.ENVIRONMENT)) {
    throw new Error(
      `Invalid ENVIRONMENT: ${JSON.stringify(env.ENVIRONMENT)} (expected 'development' or 'production')`
    );
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

  // Validate boot-time process.env tunables before opening any sockets or
  // initialising Sentry, so a typo fails immediately instead of after a
  // partial startup.
  const shutdownTimeoutMs = resolveShutdownTimeoutMs();
  const fatalOnUnhandledRejection = shouldShutdownOnUnhandledRejection();

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
    // Watchdog: if any step of the shutdown sequence hangs (a Redis client
    // wedged on a TCP retry, a background task awaiting a DB query that
    // never returns), the process would otherwise sit until the container
    // orchestrator's SIGKILL grace period runs out. Force-exit before that
    // so the orchestrator's restart loop is the only thing the operator
    // has to reason about. .unref() so the timer doesn't itself keep the
    // event loop alive if shutdown completes cleanly.
    const watchdog = setTimeout(() => {
      console.error(`[${label}] shutdown exceeded ${shutdownTimeoutMs}ms — forcing exit`);
      process.exit(1);
    }, shutdownTimeoutMs);
    watchdog.unref();
    shuttingDown = shutdown({
      server,
      cron,
      bg,
      log: (msg) => console.log(`[${label}] ${msg}`),
    })
      .then(() => {
        clearTimeout(watchdog);
        process.exit(0);
      })
      .catch((err: unknown) => {
        clearTimeout(watchdog);
        console.error("Shutdown failed:", err);
        process.exit(1);
      });
  };

  process.on("SIGTERM", () => beginShutdown("SIGTERM"));
  process.on("SIGINT", () => beginShutdown("SIGINT"));

  // Unhandled rejections: by default initiate a graceful shutdown so the
  // orchestrator restarts a clean process. Setting
  // FATAL_ON_UNHANDLED_REJECTION=false keeps the process running and just
  // logs the rejection — @sentry/node, when initialised, captures it
  // regardless via its own listener. The default mirrors Node's terminate
  // semantics from v15+ without being more aggressive; teams that
  // tolerate transient rejections from third-party libraries can opt out.
  process.on("unhandledRejection", (reason) => {
    if (fatalOnUnhandledRejection) {
      console.error("Unhandled rejection — initiating shutdown:", reason);
      beginShutdown("unhandledRejection");
      return;
    }
    console.error("Unhandled rejection (non-fatal):", reason);
  });
  // uncaughtException stays fatal: V8 documents the process state as
  // potentially corrupted, so log and exit fast rather than risk a hung
  // shutdown; the container orchestrator restarts a clean process.
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
