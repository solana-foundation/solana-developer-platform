import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(scriptDir, "..");
const wranglerBin = path.join(
  appDir,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "wrangler.cmd" : "wrangler"
);
const persistTo = process.env.SDP_API_LOCAL_PERSIST_PATH ?? ".wrangler/state";
const port = process.env.SDP_API_PORT ?? "8787";
const shouldResetLocalState = process.env.SDP_API_RESET_LOCAL_STATE === "1";
let activeChild = null;

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (activeChild && !activeChild.killed) {
      activeChild.kill(signal);
    }
  });
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: appDir,
      stdio: "inherit",
      env: {
        ...process.env,
        ...options.env,
      },
    });
    activeChild = child;

    child.on("error", reject);
    child.on("exit", (code, signal) => {
      activeChild = null;
      if (signal) {
        reject(new Error(`Command terminated by signal ${signal}`));
        return;
      }

      if (code !== 0) {
        reject(new Error(`Command failed with exit code ${code ?? 1}`));
        return;
      }

      resolve();
    });
  });
}

const devArgs = ["dev", "--local", `--persist-to=${persistTo}`, "--port", port];

try {
  if (shouldResetLocalState) {
    fs.rmSync(path.resolve(appDir, persistTo), { recursive: true, force: true });
  }
  await run(
    wranglerBin,
    ["d1", "migrations", "apply", "DB", "--local", `--persist-to=${persistTo}`],
    {
      // Wrangler skips the confirmation prompt in non-interactive mode.
      env: { CI: "1" },
    }
  );
  await run(wranglerBin, devArgs);
} catch (error) {
  const message = error instanceof Error ? error.message : "Unknown local dev startup error";
  console.error(message);
  process.exit(1);
}
