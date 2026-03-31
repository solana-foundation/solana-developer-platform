import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const mode = process.argv[2];

if (mode !== "unit" && mode !== "integration") {
  console.error("Usage: node scripts/run-workspace-tests.mjs <unit|integration>");
  process.exit(1);
}

const rootDir = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const localApiEnvPath = path.resolve(rootDir, "apps/sdp-api/.dev.vars");

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
const resolvedEnv = {
  ...localEnv,
  ...process.env,
  DATABASE_URL: databaseUrl,
  CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE: databaseUrl,
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
  await run("pnpm", ["--filter", "@sdp/api", "db:postgres:bootstrap"]);

  const filter =
    mode === "integration" ? "--filter=@sdp/api-integration" : "--filter=!@sdp/api-integration";
  await run("pnpm", ["exec", "turbo", "run", "test", filter]);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
