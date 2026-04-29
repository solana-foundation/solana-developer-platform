import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { COMMITTED_WORKER_VAR_KEYS } from "./secret-keys.mjs";

const TARGETS = new Set(["dev", "production"]);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_CONFIG_PATH = path.join(REPO_ROOT, "apps/sdp-api/wrangler.toml");

const BINDING_REPLACEMENTS = [
  {
    envVar: "CLOUDFLARE_HYPERDRIVE_ID",
    placeholders: {
      dev: "your_dev_hyperdrive_id",
      production: "your_production_hyperdrive_id",
    },
  },
  {
    envVar: "CLOUDFLARE_KV_SDP_API_KEYS_ID",
    placeholders: {
      dev: "your_dev_api_keys_kv_id",
      production: "your_production_api_keys_kv_id",
    },
  },
  {
    envVar: "CLOUDFLARE_KV_SDP_RATE_LIMITS_ID",
    placeholders: {
      dev: "your_dev_rate_limits_kv_id",
      production: "your_production_rate_limits_kv_id",
    },
  },
  {
    envVar: "CLOUDFLARE_KV_SDP_CACHE_ID",
    placeholders: {
      dev: "your_dev_cache_kv_id",
      production: "your_production_cache_kv_id",
    },
  },
  {
    envVar: "CLOUDFLARE_KV_SDP_SESSIONS_ID",
    placeholders: {
      dev: "your_dev_sessions_kv_id",
      production: "your_production_sessions_kv_id",
    },
  },
];

const API_KEY_ENV_BY_TEMPLATE_URL_KEY = new Map([
  ["SOLANA_RPC_TRITON_URL", "SOLANA_RPC_TRITON_API_KEY"],
  ["SOLANA_RPC_HELIUS_URL", "SOLANA_RPC_HELIUS_API_KEY"],
  ["SOLANA_RPC_ALCHEMY_URL", "SOLANA_RPC_ALCHEMY_API_KEY"],
  ["SOLANA_RPC_QUICKNODE_URL", "SOLANA_RPC_QUICKNODE_API_KEY"],
]);

function isPlaceholderLike(value) {
  return (
    value === "0".repeat(32) ||
    value.includes("{") ||
    value.includes("}") ||
    value.startsWith("your_") ||
    value.includes("_your_")
  );
}

function hasApiKeyTemplate(value) {
  return value.includes("{API_KEY}") || value.includes("$" + "{API_KEY}");
}

function isWorkerVarPlaceholderLike(key, value) {
  if (value === "0".repeat(32) || value.startsWith("your_") || value.includes("your-")) {
    return true;
  }

  if (!value.includes("{") && !value.includes("}")) {
    return false;
  }

  const apiKeyEnvVar = API_KEY_ENV_BY_TEMPLATE_URL_KEY.get(key);
  if (apiKeyEnvVar && hasApiKeyTemplate(value) && process.env[apiKeyEnvVar]?.trim()) {
    return false;
  }

  return true;
}

function requireBindingValue(envVar) {
  const value = process.env[envVar]?.trim();

  if (!value) {
    throw new Error(`${envVar} must be set before rendering Wrangler config.`);
  }

  if (isPlaceholderLike(value)) {
    throw new Error(`${envVar} still looks like a placeholder.`);
  }

  return value;
}

function tomlString(value) {
  return JSON.stringify(value);
}

function getTargetVarsSectionPattern(target) {
  return new RegExp(`(\\[env\\.${target}\\.vars\\]\\n)([\\s\\S]*?)(?=\\n\\[[^\\n]+\\]|$)`);
}

function renderWorkerVars(contents, target) {
  const sectionPattern = getTargetVarsSectionPattern(target);
  const match = sectionPattern.exec(contents);

  if (!match) {
    throw new Error(`Expected [env.${target}.vars] section was not found in Wrangler config.`);
  }

  const [, heading, sectionBody] = match;
  let renderedBody = sectionBody;

  for (const key of COMMITTED_WORKER_VAR_KEYS) {
    const value = process.env[key]?.trim();
    if (!value) {
      continue;
    }

    const keyPattern = new RegExp(`^${key}\\s*=\\s*.*$`, "m");
    if (!keyPattern.test(renderedBody)) {
      renderedBody = `${renderedBody.endsWith("\n") ? renderedBody : `${renderedBody}\n`}${key} = ${tomlString(value)}\n`;
      continue;
    }

    renderedBody = renderedBody.replace(keyPattern, () => `${key} = ${tomlString(value)}`);
  }

  return contents.replace(sectionPattern, () => `${heading}${renderedBody}`);
}

function validateWorkerVars(contents, target) {
  const sectionPattern = getTargetVarsSectionPattern(target);
  const match = sectionPattern.exec(contents);
  if (!match) {
    throw new Error(`Expected [env.${target}.vars] section was not found in rendered config.`);
  }

  const sectionBody = match[2];
  const invalidVars = [];

  for (const key of COMMITTED_WORKER_VAR_KEYS) {
    const keyPattern = new RegExp(`^${key}\\s*=\\s*"([^"]*)"`, "m");
    const keyMatch = keyPattern.exec(sectionBody);
    const value = keyMatch?.[1]?.trim();
    if (value && isWorkerVarPlaceholderLike(key, value)) {
      invalidVars.push(key);
    }
  }

  if (invalidVars.length > 0) {
    throw new Error(
      `Wrangler config still contains placeholder values for ${target}: ${invalidVars.join(", ")}`
    );
  }
}

function renderWranglerConfig({ configPath, outPath, target }) {
  let contents = fs.readFileSync(configPath, "utf8");

  for (const replacement of BINDING_REPLACEMENTS) {
    const placeholder = replacement.placeholders[target];
    const value = requireBindingValue(replacement.envVar);

    if (!contents.includes(placeholder)) {
      throw new Error(`Expected placeholder ${placeholder} was not found in ${configPath}.`);
    }

    contents = contents.replaceAll(placeholder, value);
  }

  contents = renderWorkerVars(contents, target);

  const remainingTargetPlaceholders = BINDING_REPLACEMENTS.map(
    (replacement) => replacement.placeholders[target]
  ).filter((placeholder) => contents.includes(placeholder));

  if (remainingTargetPlaceholders.length > 0) {
    throw new Error(
      `Wrangler config still contains unresolved ${target} placeholders: ${remainingTargetPlaceholders.join(", ")}`
    );
  }

  validateWorkerVars(contents, target);

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, contents, "utf8");
  process.stdout.write(`Rendered ${target} Wrangler config at ${outPath}\n`);
}

function printUsage() {
  process.stderr.write(
    [
      "Usage:",
      "  node scripts/render-wrangler-config.mjs --env <dev|production> --out /tmp/wrangler.toml [--config apps/sdp-api/wrangler.toml]",
      "",
    ].join("\n")
  );
}

const { values } = parseArgs({
  options: {
    config: { type: "string", default: DEFAULT_CONFIG_PATH },
    env: { type: "string" },
    out: { type: "string" },
  },
});

try {
  const target = values.env;

  if (!target || !TARGETS.has(target)) {
    throw new Error("--env must be one of: dev, production");
  }

  if (!values.out) {
    throw new Error("--out is required");
  }

  renderWranglerConfig({
    configPath: values.config,
    outPath: values.out,
    target,
  });
} catch (error) {
  printUsage();
  const message = error instanceof Error ? error.message : "Unknown Wrangler config render error";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
