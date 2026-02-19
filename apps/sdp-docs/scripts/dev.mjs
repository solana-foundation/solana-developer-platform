import { spawn } from "node:child_process";

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
  await run("pnpm", ["generate:api"]);
  await run("pnpm", ["exec", "fumadocs-mdx"]);
  await run("node", ["scripts/patch-fumadocs-source.mjs"]);

  const next = spawn("pnpm", ["exec", "next", "dev", "--port", "3001"], {
    stdio: "inherit",
    shell: false,
  });

  const shutdown = () => next.kill("SIGTERM");

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  next.on("exit", (code) => {
    process.exit(code ?? 0);
  });
};

runDev().catch((error) => {
  console.error(error);
  process.exit(1);
});
