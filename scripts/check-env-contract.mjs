import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { API_LOCAL_ENV_KEYS } from "./secret-keys.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const turbo = JSON.parse(fs.readFileSync(path.join(repoRoot, "turbo.json"), "utf8"));
const turboGlobalEnv = new Set(turbo.globalEnv ?? []);

const TURBO_IGNORE = new Set([
  "ALCHEMY_API_KEY",
  "CI",
  "DOPPLER_CONFIG",
  "DOPPLER_ENVIRONMENT",
  "DOPPLER_TOKEN",
  "GITHUB_REPOSITORY",
  "GITHUB_TOKEN",
  "HELIUS_API_KEY",
  "NEXT_RUNTIME",
  "NODE_ENV",
  "QUICKNODE_API_KEY",
  "TRITON_API_KEY",
  "VERCEL_ENV",
  "_FUMADOCS_MDX",
]);

const API_ENV_IGNORE = new Set([
  "ALCHEMY_API_KEY",
  "API_VERSION",
  "DOPPLER_CONFIG",
  "DOPPLER_ENVIRONMENT",
  "DOPPLER_TOKEN",
  "ENVIRONMENT",
  "HELIUS_API_KEY",
  "QUICKNODE_API_KEY",
  "SDP_API_KEYS",
  "SDP_API_LOCAL_PERSIST_PATH",
  "SDP_API_PORT",
  "SDP_API_RESET_LOCAL_STATE",
  "SDP_CACHE",
  "SDP_RATE_LIMITS",
  "SDP_SESSIONS",
  // Configurator-only input key (UI-only in @sdp/env-config); not an sdp-api runtime binding.
  "SIGNING_PROVIDERS",
  "TRITON_API_KEY",
]);

function runRg(pattern, targets) {
  const output = execFileSync("rg", ["-o", "--no-filename", pattern, ...targets], {
    cwd: repoRoot,
    encoding: "utf8",
  });

  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .sort();
}

function unique(values) {
  return [...new Set(values)].sort();
}

function extractProcessEnvVars() {
  const matches = runRg("process\\.env\\.([A-Z0-9_]+)", ["apps", "packages", "scripts", ".github"]);
  return unique(matches.map((value) => value.replace("process.env.", "")));
}

function extractApiBindingVars() {
  const matches = runRg("env\\.([A-Z0-9_]+)", [
    "apps/sdp-api/src",
    "apps/sdp-api/scripts",
    "packages",
  ]);
  return unique(matches.map((value) => value.replace("env.", "")));
}

function formatSection(title, values) {
  if (values.length === 0) {
    return `${title}: ok`;
  }

  return [title, ...values.map((value) => `- ${value}`)].join("\n");
}

const processEnvVars = extractProcessEnvVars();
const apiBindingVars = extractApiBindingVars();

const missingTurboEnv = processEnvVars.filter(
  (value) => !turboGlobalEnv.has(value) && !TURBO_IGNORE.has(value)
);
const missingApiEnvVars = apiBindingVars.filter(
  (value) => !API_LOCAL_ENV_KEYS.includes(value) && !API_ENV_IGNORE.has(value)
);

const report = [
  formatSection("Turbo globalEnv coverage", missingTurboEnv),
  formatSection("API local env key coverage", missingApiEnvVars),
].join("\n\n");

if (missingTurboEnv.length > 0 || missingApiEnvVars.length > 0) {
  console.error(report);
  process.exitCode = 1;
} else {
  console.log(report);
}
