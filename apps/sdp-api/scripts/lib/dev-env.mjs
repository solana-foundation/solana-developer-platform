import { spawn } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const tsxCli = createRequire(import.meta.url).resolve("tsx/cli");

function loadLocalEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return {};
  }

  const values = {};
  for (const line of fs.readFileSync(filePath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const [key, ...rest] = trimmed.split("=");
    if (!key) {
      continue;
    }

    const raw = rest.join("=");
    const quoted = raw.match(/^(['"])(.*)\1$/);
    values[key] = quoted ? quoted[2] : raw;
  }

  return values;
}

const localEnvPath = path.resolve(appDir, ".env.local");
// Written by scripts/kora-local/up.sh (pnpm dev); .env.local still wins.
const koraLocalEnvPath = path.resolve(
  process.env.KORA_LOCAL_STATE_DIR ?? path.resolve(appDir, "../../.secrets/kora-local"),
  "api.env"
);
export const localEnv = {
  ...loadLocalEnvFile(koraLocalEnvPath),
  ...loadLocalEnvFile(localEnvPath),
};
export const apiPort = localEnv.SDP_API_PORT ?? process.env.SDP_API_PORT ?? "8787";
export const workerPort = process.env.SDP_WORKER_PORT ?? "8789";
export const databaseUrl =
  // biome-ignore lint/security/noSecrets: Local Docker Postgres fallback.
  localEnv.DATABASE_URL ?? process.env.DATABASE_URL ?? "postgresql://sdp:sdp@127.0.0.1:5432/sdp";
export const redisUrl = localEnv.REDIS_URL ?? process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
let activeChild = null;

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (activeChild && !activeChild.killed) {
      activeChild.kill(signal);
      return;
    }
    process.exit(1);
  });
}

/**
 * Polls a TCP port until it accepts a connection, logging every 10 seconds.
 *
 * @param {string} label Service name used in log lines and the timeout error.
 * @param {string} rawUrl URL whose host and port are probed.
 * @param {number} defaultPort Port used when the URL names none.
 * @param {string} startHint How to start the service, appended to waiting logs and the error.
 * @param {number} timeoutSeconds How long to wait before giving up.
 * @returns {Promise<void>} Resolves once connected; rejects after `timeoutSeconds`.
 */
export async function waitForService(label, rawUrl, defaultPort, startHint, timeoutSeconds) {
  const parsed = new URL(rawUrl);
  const portNumber = parsed.port === "" ? defaultPort : Number(parsed.port);
  const startedAt = Date.now();
  const deadline = startedAt + timeoutSeconds * 1000;
  let lastLogAt = 0;

  while (true) {
    const connected = await new Promise((resolve) => {
      const socket = net.connect({ host: parsed.hostname, port: portNumber, timeout: 1_000 });
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => resolve(false));
      socket.once("timeout", () => {
        socket.destroy();
        resolve(false);
      });
    });

    if (connected) {
      if (lastLogAt > 0) {
        console.log(`${label} is up.`);
      }
      return;
    }

    const now = Date.now();
    if (now - lastLogAt >= 10_000) {
      const elapsed = Math.round((now - startedAt) / 1000);
      console.log(
        lastLogAt === 0
          ? `Waiting for ${label} at ${parsed.hostname}:${portNumber} — ${startHint}...`
          : `Still waiting for ${label} at ${parsed.hostname}:${portNumber} (${elapsed}s)...`
      );
      lastLogAt = now;
    }

    if (now > deadline) {
      throw new Error(
        `${label} did not become reachable at ${parsed.hostname}:${portNumber} within ${timeoutSeconds}s. ${startHint}.`
      );
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

/** Waits for the local Postgres and Redis that `pnpm dev`'s infrastructure task starts. */
export function waitForDataStores() {
  return Promise.all([
    waitForService(
      "Postgres",
      databaseUrl,
      5432,
      "under `pnpm dev`, the local infrastructure task starts it; otherwise run `pnpm db:postgres:up`",
      60
    ),
    waitForService(
      "Redis",
      redisUrl,
      6379,
      "under `pnpm dev`, the local infrastructure task starts it; otherwise run `pnpm db:redis:up`",
      60
    ),
  ]);
}

/**
 * Runs a child process in the app directory with the local env layered over
 * the parent's, forwarding SIGINT/SIGTERM to it.
 *
 * @param {string} command Executable to spawn.
 * @param {string[]} args Arguments for the executable.
 * @param {Record<string, string>} env Values that win over both the parent env and the local env files.
 * @returns {Promise<void>} Resolves on exit code 0; rejects on any other exit or a signal.
 */
export function run(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: appDir,
      stdio: "inherit",
      env: {
        ...process.env,
        ...localEnv,
        ...env,
      },
    });
    activeChild = child;

    child.on("error", reject);
    child.on("exit", (code, signal) => {
      activeChild = null;
      if (signal) {
        reject(new Error(`Command terminated by signal ${signal}`));
        return;
      }
      if (code !== 0) {
        reject(new Error(`Command failed with exit code ${code ?? 1}`));
        return;
      }
      resolve();
    });
  });
}

/**
 * Starts `src/server.ts` under `tsx watch` with the local runtime defaults.
 * The API and the worker are the same server, as in sdp-infra: only the port
 * and whether the in-process cron runs differ.
 *
 * @param {object} params
 * @param {string} params.port Port the server listens on.
 * @param {"true" | "false"} params.disableCron Value for the server's DISABLE_CRON.
 * @returns {Promise<void>} Settles when the watcher exits.
 */
export function watchServer({ port, disableCron }) {
  return run(process.execPath, [tsxCli, "watch", "--clear-screen=false", "src/server.ts"], {
    ENVIRONMENT: localEnv.ENVIRONMENT ?? process.env.ENVIRONMENT ?? "development",
    API_VERSION: localEnv.API_VERSION ?? process.env.API_VERSION ?? "local",
    SDP_DEPLOYMENT_MODE:
      localEnv.SDP_DEPLOYMENT_MODE ?? process.env.SDP_DEPLOYMENT_MODE ?? "self_hosted",
    // Local tooling runs every module unless told otherwise, like the compose files;
    // deployed services must set SDP_RELEASE_CHANNEL (the boot check refuses one without it).
    SDP_RELEASE_CHANNEL:
      localEnv.SDP_RELEASE_CHANNEL ?? process.env.SDP_RELEASE_CHANNEL ?? "experimental",
    DATABASE_URL: databaseUrl,
    REDIS_URL: redisUrl,
    PORT: port,
    DISABLE_CRON: disableCron,
  });
}

/** Describes where the local env came from, for the first startup log line. */
export function describeEnvSource() {
  const hasLocalEnv = fs.existsSync(localEnvPath);
  const isDopplerRun = Boolean(
    process.env.DOPPLER_CONFIG || process.env.DOPPLER_ENVIRONMENT || process.env.DOPPLER_TOKEN
  );
  if (isDopplerRun) {
    const config = process.env.DOPPLER_CONFIG ?? "unknown";
    return hasLocalEnv ? `Doppler (${config}) with .env.local overrides` : `Doppler (${config})`;
  }
  if (hasLocalEnv) {
    return ".env.local";
  }
  return "local defaults — copy apps/sdp-api/.env.local.example to apps/sdp-api/.env.local for provider configuration";
}

/**
 * Logs a startup failure and exits non-zero.
 *
 * @param {unknown} error The rejection from the launcher's startup sequence.
 * @returns {never}
 */
export function exitOnStartupError(error) {
  const message = error instanceof Error ? error.message : "Unknown local dev startup error";
  console.error(message);
  process.exit(1);
}
