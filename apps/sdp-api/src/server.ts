/**
 * SDP API — Node.js entrypoint.
 *
 * Owns the HTTP transport, the Worker's cron scheduler, logging startup,
 * and background-task tracking needed for graceful shutdown.
 *
 * The shutdown sequence lives in `runtime/shutdown-node.ts`.
 */

import { pathToFileURL } from "node:url";
import { type ServerType, serve } from "@hono/node-server";
import { SDP_RAMP_PROVIDER_STAGES } from "@sdp/types/release-channels";

import { createApp } from "@/app";
import { assertCronConfig, type CronHandle, startCron } from "@/cron/runner";
import { parseDatabaseEnv } from "@/db/database-env";
import { warmClerkSigningKeys } from "@/lib/clerk-token";
import { assertSdpReleaseChannelConfigured } from "@/lib/feature-flags";
import { getProcessEnv } from "@/lib/runtime-env";
import { createNodeExecutionContext, NodeBackgroundRunner } from "@/runtime/background-node";
import { startEgressGate } from "@/runtime/egress-gate";
import { createNodeHttpApp } from "@/runtime/http-node";
import { getLogger } from "@/runtime/logger";
import { installOutboundDispatcher } from "@/runtime/outbound-dispatcher";
import { shutdown } from "@/runtime/shutdown-node";
import { assertSigningProviderAllowed } from "@/services/adapters/signing";
import { assertCustodyEncryptionScheme } from "@/services/custody-cipher/cipher-router";
import { warnIfCustodySigningBudgetCapped } from "@/services/domain/signing/signing-timeout";
import type { Env } from "@/types/env";

const DEFAULT_PORT = 8787;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 25_000;
// Cloud Run restarts an instance whose startup probe (/health/ready) has not
// passed within 60 s of container start (sdp-infra: 20 probes, 3 s apart), so
// the egress wait ends this long after process start.
const EGRESS_WAIT_BUDGET_MS = 45_000;
const EGRESS_PROBE_INTERVAL_MS = 1_000;
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

export function assertRequiredEnv(env: Env): void {
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
  parseDatabaseEnv(env);
  assertCustodyEncryptionScheme(env);
  assertSigningProviderAllowed(env);
  assertSdpReleaseChannelConfigured(env);
}

async function main(): Promise<void> {
  installOutboundDispatcher();
  const env = getProcessEnv();
  assertRequiredEnv(env);
  warnIfCustodySigningBudgetCapped(env);

  // Validate boot-time process.env tunables before opening any sockets, so a
  // typo fails immediately instead of after a partial startup.
  const shutdownTimeoutMs = resolveShutdownTimeoutMs();
  const fatalOnUnhandledRejection = shouldShutdownOnUnhandledRejection();
  assertCronConfig(env);

  // Clerk's signing keys are the probe: the auth path needs them first, and
  // fetching them proves this instance can reach the internet.
  const egress = env.CLERK_ISSUER?.trim()
    ? startEgressGate({
        probe: () => warmClerkSigningKeys(env),
        deadlineMs: Math.max(0, EGRESS_WAIT_BUDGET_MS - Math.round(process.uptime() * 1000)),
        intervalMs: EGRESS_PROBE_INTERVAL_MS,
      })
    : undefined;

  const app = createNodeHttpApp(
    createApp({
      rampProviderStages: SDP_RAMP_PROVIDER_STAGES,
      egressReadiness: egress?.state,
    })
  );
  const bg = new NodeBackgroundRunner();
  let cron: CronHandle | null = null;

  const port = resolvePort();
  const server: ServerType = serve({
    fetch: (req) => app.fetch(req, env, createNodeExecutionContext(bg)),
    port,
  });

  getLogger().info({ port }, "sdp-api listening");

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
      getLogger().error(
        { label, timeout_ms: shutdownTimeoutMs },
        "shutdown exceeded timeout — forcing exit"
      );
      process.exit(1);
    }, shutdownTimeoutMs);
    watchdog.unref();
    shuttingDown = shutdown({
      server,
      cron,
      bg,
      log: (msg) => getLogger().info({ label }, msg),
    })
      .then(() => {
        clearTimeout(watchdog);
        process.exit(0);
      })
      .catch((err: unknown) => {
        clearTimeout(watchdog);
        getLogger().error({ error: err }, "Shutdown failed");
        process.exit(1);
      });
  };

  process.on("SIGTERM", () => beginShutdown("SIGTERM"));
  process.on("SIGINT", () => beginShutdown("SIGINT"));

  // Unhandled rejections: by default initiate a graceful shutdown so the
  // orchestrator restarts a clean process. Setting
  // FATAL_ON_UNHANDLED_REJECTION=false keeps the process running and just
  // logs the rejection. The default mirrors Node's terminate
  // semantics from v15+ without being more aggressive; teams that
  // tolerate transient rejections from third-party libraries can opt out.
  process.on("unhandledRejection", (reason) => {
    if (fatalOnUnhandledRejection) {
      getLogger().error({ error: reason }, "Unhandled rejection — initiating shutdown");
      beginShutdown("unhandledRejection");
      return;
    }
    getLogger().error({ error: reason }, "Unhandled rejection (non-fatal)");
  });
  // uncaughtException stays fatal: V8 documents the process state as
  // potentially corrupted, so log and exit fast rather than risk a hung
  // shutdown; the container orchestrator restarts a clean process.
  process.on("uncaughtException", (err) => {
    getLogger().error({ error: err }, "Uncaught exception — exiting");
    process.exit(1);
  });

  // Scheduled work calls out from its first tick, so it waits for the same
  // egress readiness does. A shutdown that began meanwhile cancels it.
  await egress?.settled;
  if (shuttingDown === null) {
    cron = startCron({ env, bg });
  }
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  main().catch((err: unknown) => {
    getLogger().error({ error: err }, "Fatal startup error");
    process.exit(1);
  });
}
