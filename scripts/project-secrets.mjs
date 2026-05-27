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
