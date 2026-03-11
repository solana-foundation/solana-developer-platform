import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const collectionPath = path.join(
  repoRoot,
  "apps/sdp-docs/public/downloads/sdp-api-admin.postman_collection.json"
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

const args = [
  "exec",
  "newman",
  "run",
  collectionPath,
  "--bail",
  "--reporters",
  "cli",
  "--env-var",
  `baseUrl=${baseUrl}`,
  "--env-var",
  `apiKey=${apiKey}`,
];

const child = spawn("pnpm", args, {
  cwd: repoRoot,
  env: process.env,
  stdio: "inherit",
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exit(code ?? 1);
});
