import { spawn } from "node:child_process";
import { watch } from "node:fs";
import { resolve } from "node:path";
import { start } from "fumadocs-mdx/next";

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

let isPatching = false;
let patchQueued = false;
let patchTimer;

const schedulePatch = () => {
  patchQueued = true;
  clearTimeout(patchTimer);
  patchTimer = setTimeout(() => {
    void flushPatch();
  }, 40);
};

const flushPatch = async () => {
  if (!patchQueued || isPatching) {
    return;
  }

  patchQueued = false;
  isPatching = true;

  try {
    await run("node", ["scripts/patch-fumadocs-source.mjs"]);
    await run("pnpm", ["generate:ai"]);
  } catch (error) {
    console.error("[MDX] failed to patch generated source");
    console.error(error);
  } finally {
    isPatching = false;
    if (patchQueued) {
      void flushPatch();
    }
  }
};

await start(true, "source.config.ts", ".source");
await run("node", ["scripts/patch-fumadocs-source.mjs"]);

const sourceDirWatcher = watch(resolve(".source"), (eventType, fileName) => {
  if (eventType !== "change" && eventType !== "rename") {
    return;
  }
  if (fileName && fileName !== "index.ts") {
    return;
  }
  schedulePatch();
});

console.log("[MDX] source watcher active");

const shutdown = () => {
  clearTimeout(patchTimer);
  sourceDirWatcher.close();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
