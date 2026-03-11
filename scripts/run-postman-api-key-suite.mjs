import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const collectionPath = path.join(
  repoRoot,
  "apps/sdp-docs/public/downloads/sdp-api-admin.postman_collection.json"
);
const environmentTemplatePath = path.join(
  repoRoot,
  "apps/sdp-docs/public/downloads/sdp-api-admin.postman_environment.template.json"
);

const baseUrl = process.env.POSTMAN_API_BASE_URL?.trim();
const apiKey = process.env.POSTMAN_ADMIN_API_KEY?.trim();

if (!baseUrl) {
  console.error(
    "Missing POSTMAN_API_BASE_URL. Set it to the deployed sandbox API base URL for the dedicated CI admin org."
  );
  process.exit(1);
}

if (!apiKey) {
  console.error(
    "Missing POSTMAN_ADMIN_API_KEY. Create a dedicated sandbox admin API key for the CI org and add it to GitHub Actions secrets."
  );
  process.exit(1);
}

async function createEnvironmentFile() {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "sdp-postman-"));
  const environmentPath = path.join(tmpDir, "environment.json");
  const template = JSON.parse(await readFile(environmentTemplatePath, "utf8"));

  template.values = template.values.map((entry) => {
    if (entry.key === "baseUrl") {
      return { ...entry, value: baseUrl };
    }

    if (entry.key === "apiKey") {
      return { ...entry, value: apiKey };
    }

    return entry;
  });

  await writeFile(environmentPath, `${JSON.stringify(template, null, 2)}\n`, "utf8");
  return { tmpDir, environmentPath };
}

async function main() {
  const { tmpDir, environmentPath } = await createEnvironmentFile();

  try {
    const args = [
      "exec",
      "newman",
      "run",
      collectionPath,
      "--bail",
      "--reporters",
      "cli",
      "--environment",
      environmentPath,
    ];

    const exitCode = await new Promise((resolve, reject) => {
      const child = spawn("pnpm", args, {
        cwd: repoRoot,
        env: process.env,
        stdio: "inherit",
      });

      child.on("error", reject);
      child.on("exit", (code, signal) => {
        if (signal) {
          process.kill(process.pid, signal);
          return;
        }

        resolve(code ?? 1);
      });
    });

    process.exit(exitCode);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
