import { spawn } from "node:child_process";
import fs from "node:fs";
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
  process.env.DATABASE_URL ?? localEnv.DATABASE_URL ?? localDatabaseUrl.toString();
const wranglerVarArgs = isDopplerRun ? collectWranglerVars(process.env) : [];
let activeChild = null;

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (activeChild && !activeChild.killed) {
      activeChild.kill(signal);
    }
  });
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: appDir,
      stdio: "inherit",
      env: {
        ...localEnv,
        ...process.env,
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

try {
  if (isDopplerRun && fs.existsSync(localEnvPath)) {
    throw new Error(
      "Legacy apps/sdp-api/.dev.vars detected while running under Doppler. Remove or rename it so Wrangler can inject Doppler-backed bindings with `--var`."
    );
  }

  if (shouldResetLocalState) {
    fs.rmSync(path.resolve(appDir, persistTo), { recursive: true, force: true });
  }
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
