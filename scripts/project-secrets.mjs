import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { CLOUDFLARE_SECRET_KEYS, DOCKER_ENV_KEYS } from "./secret-keys.mjs";

function collectEntries(keys) {
  return keys
    .map((key) => [key, process.env[key]])
    .filter((entry) => typeof entry[1] === "string" && entry[1].length > 0)
    .map(([key, value]) => [key, value.replace(/\r\n/g, "\n").replace(/\n/g, "\\n")]);
}

function emit(contents, outPath) {
  if (outPath) {
    fs.writeFileSync(outPath, contents, "utf8");
    process.stdout.write(`wrote ${outPath}\n`);
    return;
  }
  process.stdout.write(contents);
}

function writeCloudflareSecretPayload(outPath) {
  const payload = Object.fromEntries(collectEntries(CLOUDFLARE_SECRET_KEYS));
  emit(`${JSON.stringify(payload, null, 2)}\n`, outPath);
}

function parsePositiveInteger(value, optionName) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${optionName} must be a positive integer.`);
  }
  return parsed;
}

function writeCloudflareSecretBatches(outDir, batchSize) {
  if (!outDir) {
    throw new Error("cloudflare-batches requires --out-dir.");
  }

  fs.mkdirSync(outDir, { recursive: true });

  const entries = collectEntries(CLOUDFLARE_SECRET_KEYS);
  if (entries.length === 0) {
    process.stdout.write("wrote 0 Cloudflare secret batches\n");
    return;
  }

  const totalBatches = Math.ceil(entries.length / batchSize);
  for (let i = 0; i < totalBatches; i += 1) {
    const batch = entries.slice(i * batchSize, (i + 1) * batchSize);
    const payload = Object.fromEntries(batch);
    const batchNumber = String(i + 1).padStart(3, "0");
    const outPath = path.join(outDir, `cloudflare-secrets-${batchNumber}.json`);
    emit(`${JSON.stringify(payload, null, 2)}\n`, outPath);
  }
}

function ensureDockerSafe(key, value) {
  // godotenv (used by docker compose --env-file) strips leading whitespace
  // from unquoted values and truncates them at any inline comment marker —
  // any whitespace character followed by `#`, not just a literal space.
  // Both shapes corrupt silently, so surface them at export time.
  if (/^\s/.test(value)) {
    throw new Error(
      `Value for ${key} has leading whitespace; docker compose --env-file silently strips it, so the container sees a different value than the upstream secret. Trim it in the upstream secret store.`
    );
  }
  if (/\s#/.test(value)) {
    throw new Error(
      `Value for ${key} contains whitespace immediately followed by '#'; docker compose --env-file treats that as an inline comment and silently truncates the value. Rewrite the upstream secret to avoid that sequence.`
    );
  }
}

function writeDockerEnvFile(outPath) {
  const entries = collectEntries(DOCKER_ENV_KEYS);
  for (const [k, v] of entries) ensureDockerSafe(k, v);
  const lines = entries.map(([k, v]) => `${k}=${v}`);
  emit(lines.length === 0 ? "" : `${lines.join("\n")}\n`, outPath);
}

function printUsage() {
  process.stderr.write(
    [
      "Usage:",
      "  node scripts/project-secrets.mjs cloudflare [--out /tmp/cloudflare-secrets.json]",
      "  node scripts/project-secrets.mjs cloudflare-batches --out-dir /tmp/cloudflare-secrets [--batch-size 25]",
      "  node scripts/project-secrets.mjs docker [--out /tmp/.env.docker]",
      "",
    ].join("\n")
  );
}

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    "batch-size": { type: "string", default: "25" },
    out: { type: "string" },
    "out-dir": { type: "string" },
  },
});

const command = positionals[0];

try {
  switch (command) {
    case "cloudflare":
      writeCloudflareSecretPayload(values.out);
      break;
    case "cloudflare-batches":
      writeCloudflareSecretBatches(
        values["out-dir"],
        parsePositiveInteger(values["batch-size"], "--batch-size")
      );
      break;
    case "docker":
      writeDockerEnvFile(values.out);
      break;
    default:
      printUsage();
      process.exitCode = 1;
  }
} catch (error) {
  const message = error instanceof Error ? error.message : "Unknown secret projection error";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
