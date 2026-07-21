import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(scriptDir, "..");
const tsxBin = path.join(
  appDir,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "tsx.cmd" : "tsx"
);

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
const localEnv = loadLocalEnvFile(localEnvPath);
const port = localEnv.SDP_API_PORT ?? process.env.SDP_API_PORT ?? "8787";
const databaseUrl =
  // biome-ignore lint/security/noSecrets: Local Docker Postgres fallback.
  localEnv.DATABASE_URL ?? process.env.DATABASE_URL ?? "postgresql://sdp:sdp@127.0.0.1:5432/sdp";
const redisUrl = localEnv.REDIS_URL ?? process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
const shouldResetLocalState =
  (localEnv.SDP_API_RESET_LOCAL_STATE ?? process.env.SDP_API_RESET_LOCAL_STATE) === "1";
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

async function waitForService(label, rawUrl, defaultPort, startHint) {
  const parsed = new URL(rawUrl);
  const portNumber = parsed.port === "" ? defaultPort : Number(parsed.port);
  const startedAt = Date.now();
  const deadline = startedAt + 60_000;
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
        `${label} did not become reachable at ${parsed.hostname}:${portNumber} within 60s. ${startHint}.`
      );
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: appDir,
      stdio: "inherit",
      env: {
        ...process.env,
        ...localEnv,
        ...options.env,
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

async function resetLocalRedisState(url) {
  const parsed = new URL(url);
  const loopbackHosts = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
  if (!loopbackHosts.has(parsed.hostname)) {
    throw new Error(
      "SDP_API_RESET_LOCAL_STATE=1 is restricted to loopback Redis instances to protect shared data."
    );
  }

  const { default: Redis } = await import("ioredis");
  const client = new Redis(url, { maxRetriesPerRequest: 1 });
  try {
    for (const prefix of ["apiKeys", "rateLimits", "cache", "sessions"]) {
      let cursor = "0";
      do {
        const [nextCursor, keys] = await client.scan(cursor, "MATCH", `${prefix}:*`, "COUNT", 100);
        if (keys.length > 0) {
          await client.unlink(...keys);
        }
        cursor = nextCursor;
      } while (cursor !== "0");
    }
  } finally {
    await client.quit();
  }
}

function describeEnvSource() {
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

try {
  console.log(`Environment: ${describeEnvSource()}`);
  await Promise.all([
    waitForService(
      "Postgres",
      databaseUrl,
      5432,
      "under `pnpm dev`, the local infrastructure task starts it; otherwise run `pnpm db:postgres:up`"
    ),
    waitForService(
      "Redis",
      redisUrl,
      6379,
      "under `pnpm dev`, the local infrastructure task starts it; otherwise run `pnpm db:postgres:up`"
    ),
  ]);

  if (shouldResetLocalState) {
    await resetLocalRedisState(redisUrl);
  }

  await run("node", ["scripts/migrate-postgres.mjs"], {
    env: { DATABASE_URL: databaseUrl },
  });
  await run(tsxBin, ["watch", "--clear-screen=false", "src/server.ts"], {
    env: {
      ENVIRONMENT: localEnv.ENVIRONMENT ?? process.env.ENVIRONMENT ?? "development",
      API_VERSION: localEnv.API_VERSION ?? process.env.API_VERSION ?? "local",
      DATABASE_URL: databaseUrl,
      REDIS_URL: redisUrl,
      PORT: port,
    },
  });
} catch (error) {
  const message = error instanceof Error ? error.message : "Unknown local dev startup error";
  console.error(message);
  process.exit(1);
}
