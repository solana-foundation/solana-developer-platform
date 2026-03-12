import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";

const run = (command, args) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      shell: false,
    });

    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} ${args.join(" ")} failed with code ${code ?? -1}`));
      }
    });
  });

const runDev = async () => {
  await rm(resolve(".next"), { recursive: true, force: true });
  await run("pnpm", ["generate:api"]);
  await run("pnpm", ["generate:ai"]);
  await run("pnpm", ["generate:source"]);

  const sourceWatcher = spawn("node", ["scripts/watch-source.mjs"], {
    stdio: "inherit",
    shell: false,
  });

  const next = spawn("pnpm", ["exec", "next", "dev", "--port", "3001"], {
    stdio: "inherit",
    shell: false,
  });

  const shutdown = () => {
    sourceWatcher.kill("SIGTERM");
    next.kill("SIGTERM");
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  sourceWatcher.on("exit", (code) => {
    if (code && code !== 0) {
      next.kill("SIGTERM");
      process.exit(code);
    }
  });

  next.on("exit", (code) => {
    sourceWatcher.kill("SIGTERM");
    process.exit(code ?? 0);
  });
};

runDev().catch((error) => {
  console.error(error);
  process.exit(1);
});
