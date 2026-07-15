import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { API_LOCAL_ENV_KEYS } from "../../../scripts/secret-keys.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(scriptDir, "..");
const wranglerBin = path.join(
  appDir,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "wrangler.cmd" : "wrangler"
);

function loadLocalEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return {};
  }

  const content = fs.readFileSync(filePath, "utf8");
  const values = {};

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const [key, ...rest] = trimmed.split("=");
    if (!key) {
      continue;
    }

    values[key] = rest.join("=");
  }

  return values;
}

function collectWranglerVars(source) {
  return API_LOCAL_ENV_KEYS.flatMap((key) => {
    const value = source[key];
    if (typeof value !== "string" || value.length === 0) {
      return [];
    }

    return ["--var", `${key}:${value.replace(/\r\n/g, "\n")}`];
  });
}

const localEnvPath = path.resolve(appDir, ".dev.vars");
const localEnv = loadLocalEnvFile(localEnvPath);
const persistTo = process.env.SDP_API_LOCAL_PERSIST_PATH ?? ".wrangler/state";
const port = process.env.SDP_API_PORT ?? "8787";
const shouldResetLocalState = process.env.SDP_API_RESET_LOCAL_STATE === "1";
const isDopplerRun = Boolean(
  process.env.DOPPLER_CONFIG || process.env.DOPPLER_ENVIRONMENT || process.env.DOPPLER_TOKEN
);
const localDatabaseUrl = new URL("postgresql://127.0.0.1:5432/sdp");
localDatabaseUrl.username = "sdp";
localDatabaseUrl.password = "sdp";
const databaseUrl =
  localEnv.DATABASE_URL ?? process.env.DATABASE_URL ?? localDatabaseUrl.toString();
const wranglerVarArgs = isDopplerRun ? collectWranglerVars({ ...process.env, ...localEnv }) : [];
let activeChild = null;

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (activeChild && !activeChild.killed) {
      activeChild.kill(signal);
    }
  });
}

/**
 * Blocks until the Postgres port accepts TCP connections, so the API task can
 * start in parallel with the `dev:db` compose task without losing the race.
 */
async function waitForPostgres(url) {
  const parsed = new URL(url);
  const port = parsed.port === "" ? 5432 : Number(parsed.port);
  const startedAt = Date.now();
  const deadline = startedAt + 60_000;
  let lastLogAt = 0;

  while (true) {
    const connected = await new Promise((resolve) => {
      const socket = net.connect({ host: parsed.hostname, port, timeout: 1_000 });
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
        console.log("Postgres is up.");
      }
      return;
    }

    const now = Date.now();
    if (now - lastLogAt >= 10_000) {
      const elapsed = Math.round((now - startedAt) / 1000);
      console.log(
        lastLogAt === 0
          ? `Waiting for Postgres at ${parsed.hostname}:${port} — under \`pnpm dev\` the dev:db task is starting it; if nothing is, run \`pnpm db:postgres:up\`...`
          : `Still waiting for Postgres at ${parsed.hostname}:${port} (${elapsed}s)...`
      );
      lastLogAt = now;
    }

    if (now > deadline) {
      throw new Error(
        `Postgres did not become reachable at ${parsed.hostname}:${port} within 60s. Start it with \`pnpm db:postgres:up\` (or check DATABASE_URL if it points elsewhere).`
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

const devArgs = ["dev", "--local", `--persist-to=${persistTo}`, "--port", port, ...wranglerVarArgs];

/**
 * One-line summary of where env came from, printed inside the task pane —
 * output the wrapper prints before exec'ing turbo is hidden by the TUI.
 */
function describeEnvSource() {
  const hasDevVars = fs.existsSync(localEnvPath);
  if (isDopplerRun) {
    const config = process.env.DOPPLER_CONFIG ?? "unknown";
    return hasDevVars ? `Doppler (${config}) with .dev.vars overrides` : `Doppler (${config})`;
  }
  if (hasDevVars) {
    return ".dev.vars only — SDP recommends a secrets manager like Doppler to share keys (https://docs.doppler.com/docs/install-cli)";
  }
  return "none found — copy apps/sdp-api/.dev.vars.example to apps/sdp-api/.dev.vars to get started (or install the Doppler CLI)";
}

try {
  console.log(`Environment secrets: ${describeEnvSource()}`);
  if (shouldResetLocalState) {
    fs.rmSync(path.resolve(appDir, persistTo), { recursive: true, force: true });
  }
  await waitForPostgres(databaseUrl);
  await run("node", ["scripts/migrate-postgres.mjs"], {
    env: {
      DATABASE_URL: databaseUrl,
    },
  });
  await run(wranglerBin, devArgs, {
    env: {
      DATABASE_URL: databaseUrl,
      CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE: databaseUrl,
      CLOUDFLARE_INCLUDE_PROCESS_ENV: "true",
    },
  });
} catch (error) {
  const message = error instanceof Error ? error.message : "Unknown local dev startup error";
  console.error(message);
  process.exit(1);
}
