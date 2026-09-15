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
const localApiEnvPath = path.resolve(rootDir, "apps/sdp-api/.env.local");

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
// biome-ignore lint/security/noSecrets: Local Docker Postgres fallback for isolated tests.
const localTestDatabaseUrl = "postgresql://sdp:sdp@127.0.0.1:5432/sdp_test";
const testDatabaseUrl =
  process.env.TEST_DATABASE_URL ?? localEnv.TEST_DATABASE_URL ?? localTestDatabaseUrl;
const redisUrl = process.env.REDIS_URL ?? localEnv.REDIS_URL ?? "redis://127.0.0.1:6379";

const resolvedEnv = {
  ...localEnv,
  ...process.env,
  TEST_DATABASE_URL: testDatabaseUrl,
  REDIS_URL: redisUrl,
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

const TEST_SHARD_PATTERN = /^[1-9]\d*\/[1-9]\d*$/;

/**
 * Parses the `TEST_SHARD` environment variable (`<index>/<count>`, e.g. `2/4`).
 * An unset or empty value means "run the whole suite unsharded" and yields
 * `undefined`; any other malformed value is a hard error so a typo in CI can
 * never silently run the full suite or an overlapping subset.
 *
 * @param {string | undefined} raw Value of `process.env.TEST_SHARD`.
 * @returns {string | undefined} The validated `<index>/<count>` string, or `undefined` when unset.
 * @throws {Error} When the value is set but does not match `<positive-index>/<positive-count>`.
 */
function parseTestShard(raw) {
  const trimmed = raw?.trim();
  if (trimmed === undefined || trimmed === "") {
    return undefined;
  }

  if (!TEST_SHARD_PATTERN.test(trimmed)) {
    throw new Error(
      `TEST_SHARD must be formatted as <index>/<count> with positive integers (e.g. "1/4"), received: ${trimmed}`
    );
  }

  const [index, count] = trimmed.split("/");
  if (Number(index) > Number(count)) {
    throw new Error(`TEST_SHARD index must not exceed count, received: ${trimmed}`);
  }

  return trimmed;
}

try {
  if (mode === "integration") {
    await configureIntegrationSolanaRpc(resolvedEnv);
  }

  if (mode === "integration") {
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
    const changedSince = mode === "unit" ? process.env.TEST_CHANGED_SINCE?.trim() : undefined;
    const split = mode === "unit" ? process.env.TEST_WORKSPACE_SPLIT?.trim() : undefined;
    const testShard = mode === "unit" ? parseTestShard(process.env.TEST_SHARD) : undefined;
    const filters =
      mode === "integration"
        ? ["--filter=@sdp/api-integration"]
        : split === "api"
          ? ["--filter=@sdp/api"]
          : split === "rest"
            ? changedSince
              ? [
                  `--filter=...[${changedSince}]`,
                  "--filter=!@sdp/api",
                  "--filter=!@sdp/api-integration",
                ]
              : ["--filter=!@sdp/api", "--filter=!@sdp/api-integration"]
            : changedSince
              ? [`--filter=...[${changedSince}]`, "--filter=!@sdp/api-integration"]
              : ["--filter=!@sdp/api-integration"];
    const cacheDir = process.env.TURBO_CACHE_DIR?.trim();
    const vitestShardArgs = testShard
      ? [`--shard=${testShard}`, "--reporter=blob", "--reporter=default"]
      : [];
    const passthroughArgs =
      forwardedArgs.length > 0 || vitestShardArgs.length > 0
        ? ["--", ...forwardedArgs, ...vitestShardArgs]
        : [];
    await run("pnpm", [
      "exec",
      "turbo",
      "run",
      "test",
      ...(cacheDir ? [`--cache-dir=${cacheDir}`] : []),
      ...filters,
      ...passthroughArgs,
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
