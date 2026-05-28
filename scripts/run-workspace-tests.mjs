import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { safeHostname, selectHealthySolanaRpcUrl } from "./lib/solana-rpc-health.mjs";

const mode = process.argv[2];
const rawForwardedArgs = process.argv.slice(3);
const forwardedArgs = rawForwardedArgs[0] === "--" ? rawForwardedArgs.slice(1) : rawForwardedArgs;

if (mode !== "unit" && mode !== "integration") {
  console.error("Usage: node scripts/run-workspace-tests.mjs <unit|integration> [test-files...]");
  process.exit(1);
}

const rootDir = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const localApiEnvPath = path.resolve(rootDir, "apps/sdp-api/.dev.vars");
const isDopplerRun = Boolean(
  process.env.DOPPLER_CONFIG || process.env.DOPPLER_ENVIRONMENT || process.env.DOPPLER_TOKEN
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

    const raw = rest.join("=");
    const quoted = raw.match(/^(['"])(.*)\1$/);
    values[key] = quoted ? quoted[2] : raw;
  }

  return values;
}

const localEnv = loadLocalEnvFile(localApiEnvPath);
const localDatabaseUrl = new URL("postgresql://127.0.0.1:5432/sdp");
localDatabaseUrl.username = "sdp";
localDatabaseUrl.password = "sdp";
const databaseUrl =
  process.env.DATABASE_URL ?? localEnv.DATABASE_URL ?? localDatabaseUrl.toString();

if (isDopplerRun && fs.existsSync(localApiEnvPath)) {
  console.error(
    "Legacy apps/sdp-api/.dev.vars detected while running tests under Doppler. Remove or rename it so Wrangler can use process env from `doppler run`."
  );
  process.exit(1);
}

const resolvedEnv = {
  ...localEnv,
  ...process.env,
  DATABASE_URL: databaseUrl,
  CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE: databaseUrl,
  CLOUDFLARE_INCLUDE_PROCESS_ENV: "true",
};

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: rootDir,
      stdio: "inherit",
      env: resolvedEnv,
      ...options,
    });

    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`Command terminated by signal ${signal}`));
        return;
      }

      if ((code ?? 1) !== 0) {
        reject(new Error(`Command failed with exit code ${code ?? 1}`));
        return;
      }

      resolve();
    });
  });
}

try {
  if (mode === "integration") {
    await configureIntegrationSolanaRpc(resolvedEnv);
  }

  await run("pnpm", ["--filter", "@sdp/api", "db:postgres:bootstrap"]);

  if (mode === "unit") {
    await run("pnpm", ["--filter", "@sdp/api", "db:migrate:test"]);
  }

  if (mode === "integration" && forwardedArgs.length > 0) {
    await run("pnpm", [
      "--filter",
      "@sdp/api-integration",
      "exec",
      "vitest",
      "run",
      ...forwardedArgs,
    ]);
  } else {
    const filter =
      mode === "integration" ? "--filter=@sdp/api-integration" : "--filter=!@sdp/api-integration";
    await run("pnpm", [
      "exec",
      "turbo",
      "run",
      "test",
      filter,
      ...(forwardedArgs.length > 0 ? ["--", ...forwardedArgs] : []),
    ]);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

async function configureIntegrationSolanaRpc(env) {
  const selected = await selectHealthySolanaRpcUrl(env);
  if (!selected) {
    return;
  }

  env.SOLANA_RPC_URL = selected.url;
  env.SOLANA_RPC_DEFAULT_PROVIDER = "default";
  console.log(`Using ${selected.id} Solana RPC for integration (${safeHostname(selected.url)}).`);
}
