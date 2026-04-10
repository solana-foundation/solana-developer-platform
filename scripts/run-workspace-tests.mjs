import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const mode = process.argv[2];
const forwardedArgs = process.argv.slice(3);

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

    values[key] = rest.join("=");
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
  console.log(`Using ${selected.key} for integration Solana RPC (${safeHostname(selected.url)}).`);
}

async function selectHealthySolanaRpcUrl(env) {
  const candidates = getSolanaRpcCandidates(env);
  if (candidates.length === 0) {
    return undefined;
  }

  const failures = [];
  for (const candidate of candidates) {
    try {
      await assertSolanaRpcHealthy(candidate.url);
      return candidate;
    } catch (error) {
      failures.push(
        `${candidate.key} (${safeHostname(candidate.url)}): ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  throw new Error(
    `No healthy Solana RPC URL found for integration tests. Checked: ${failures.join("; ")}`
  );
}

function getSolanaRpcCandidates(env) {
  const keys = [
    "SOLANA_RPC_URL",
    "SOLANA_RPC_ALCHEMY_URL",
    "SOLANA_RPC_QUICKNODE_URL",
    "SOLANA_RPC_TRITON_URL",
    "SOLANA_RPC_HELIUS_URL",
  ];
  const seen = new Set();

  return keys.flatMap((key) => {
    const url = env[key];
    if (!url || seen.has(url)) {
      return [];
    }

    seen.add(url);
    return [{ key, url }];
  });
}

async function assertSolanaRpcHealthy(rpcUrl) {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    // biome-ignore lint/nursery/noSecrets: JSON-RPC method name, not a secret.
    method: "getLatestBlockhash",
    params: [{ commitment: "confirmed" }],
  });
  const response = await fetchWithTimeout(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const payload = await response.json();
  if (payload.error) {
    throw new Error(payload.error.message ?? "unknown JSON-RPC error");
  }

  if (!payload.result?.value?.blockhash) {
    throw new Error("missing latest blockhash");
  }
}

async function fetchWithTimeout(url, init) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);

  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function safeHostname(rawUrl) {
  try {
    return new URL(rawUrl).hostname;
  } catch {
    return "invalid-url";
  }
}
