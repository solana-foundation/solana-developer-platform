import { spawn } from "node:child_process";
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

const runSourceGeneration = async () => {
  await postInstall({ configPath: "source.config.ts", outDir: ".source" });
  await run("node", ["scripts/patch-fumadocs-source.mjs"]);
};

runSourceGeneration().catch((error) => {
  console.error(error);
  process.exit(1);
});
