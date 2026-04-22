import { spawn } from "node:child_process";
import { watch } from "node:fs";
import { resolve } from "node:path";
import { postInstall } from "fumadocs-mdx/next";

const run = (command, args) =>
  new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      shell: false,
    });

    child.on("error", rejectPromise);
    child.on("exit", (code) => {
      if (code === 0) {
        resolvePromise();
      } else {
        rejectPromise(new Error(`${command} ${args.join(" ")} failed with code ${code ?? -1}`));
      }
    });
  });

let isRegenerating = false;
let regenerateQueued = false;
let regenerateTimer;

const scheduleRegenerate = () => {
  regenerateQueued = true;
  clearTimeout(regenerateTimer);
  regenerateTimer = setTimeout(() => {
    void flushRegenerate();
  }, 40);
};

const flushRegenerate = async () => {
  if (!regenerateQueued || isRegenerating) {
    return;
  }

  regenerateQueued = false;
  isRegenerating = true;

  try {
    await postInstall({ configPath: "source.config.ts", outDir: ".source" });
    await run("node", ["scripts/patch-fumadocs-source.mjs"]);
    await run("pnpm", ["generate:ai"]);
  } catch (error) {
    console.error("[MDX] failed to regenerate source");
    console.error(error);
  } finally {
    isRegenerating = false;
    if (regenerateQueued) {
      void flushRegenerate();
    }
  }
};

regenerateQueued = true;
await flushRegenerate();

const sourceConfigWatcher = watch(resolve("source.config.ts"), () => {
  scheduleRegenerate();
});

const contentWatcher = watch(
  resolve("content/docs"),
  { recursive: true },
  (eventType, fileName) => {
    if (eventType !== "change" && eventType !== "rename") {
      return;
    }
    if (fileName && !/\.(md|mdx|json|ya?ml)$/.test(fileName)) {
      return;
    }
    scheduleRegenerate();
  }
);

console.log("[MDX] source watcher active");

const shutdown = () => {
  clearTimeout(regenerateTimer);
  sourceConfigWatcher.close();
  contentWatcher.close();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
