import fs from "node:fs";
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

function ensureDockerSafe(key, value) {
  // docker compose --env-file uses each line verbatim after the first `=`,
  // with godotenv-style quote stripping. These two value shapes silently
  // corrupt parsing instead of failing loudly, so we surface them here.
  if (/^\s/.test(value)) {
    throw new Error(
      `Value for ${key} has leading whitespace; docker compose --env-file preserves it verbatim. Trim it in the upstream secret store.`
    );
  }
  if (value.startsWith("#")) {
    throw new Error(
      `Value for ${key} starts with '#'; docker compose --env-file would treat that line as a comment and drop the key. Adjust the upstream secret.`
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
      "  node scripts/project-secrets.mjs docker [--out /tmp/.env.docker]",
      "",
    ].join("\n")
  );
}

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    out: { type: "string" },
  },
});

const command = positionals[0];

try {
  switch (command) {
    case "cloudflare":
      writeCloudflareSecretPayload(values.out);
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
