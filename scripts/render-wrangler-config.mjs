import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

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

function isPlaceholderLike(value) {
  return (
    value === "0".repeat(32) ||
    value.includes("{") ||
    value.includes("}") ||
    value.startsWith("your_") ||
    value.includes("_your_")
  );
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

  const remainingTargetPlaceholders = BINDING_REPLACEMENTS.map(
    (replacement) => replacement.placeholders[target]
  ).filter((placeholder) => contents.includes(placeholder));

  if (remainingTargetPlaceholders.length > 0) {
    throw new Error(
      `Wrangler config still contains unresolved ${target} placeholders: ${remainingTargetPlaceholders.join(", ")}`
    );
  }

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
