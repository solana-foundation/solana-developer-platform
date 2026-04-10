import fs from "node:fs";
import { parseArgs } from "node:util";
import { CLOUDFLARE_SECRET_KEYS } from "./secret-keys.mjs";

function collectEntries(keys) {
  return keys
    .map((key) => [key, process.env[key]])
    .filter((entry) => typeof entry[1] === "string" && entry[1].length > 0)
    .map(([key, value]) => [key, value.replace(/\r\n/g, "\n").replace(/\n/g, "\\n")]);
}

function writeCloudflareSecretPayload(outPath) {
  const payload = Object.fromEntries(collectEntries(CLOUDFLARE_SECRET_KEYS));
  const contents = `${JSON.stringify(payload, null, 2)}\n`;

  if (outPath) {
    fs.writeFileSync(outPath, contents, "utf8");
    process.stdout.write(`wrote ${outPath}\n`);
    return;
  }

  process.stdout.write(contents);
}

function printUsage() {
  process.stderr.write(
    [
      "Usage:",
      "  node scripts/project-secrets.mjs cloudflare [--out /tmp/cloudflare-secrets.json]",
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
    default:
      printUsage();
      process.exitCode = 1;
  }
} catch (error) {
  const message = error instanceof Error ? error.message : "Unknown secret projection error";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
