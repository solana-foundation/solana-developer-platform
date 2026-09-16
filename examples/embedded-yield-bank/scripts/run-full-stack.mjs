import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";

const preview = process.argv.includes("--preview");
const executable = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const childEnvironment = {
  ...process.env,
  NORTHSTAR_DEMO_SESSION_TOKEN: randomBytes(32).toString("base64url"),
};
const commands = [
  [
    "exec",
    "tsx",
    preview ? "server/index.ts" : "watch",
    ...(preview ? [] : ["server/index.ts"]),
  ],
  [
    "exec",
    "vite",
    preview ? "preview" : "--host",
    ...(preview ? ["--host"] : []),
    "127.0.0.1",
    "--port",
    "4173",
  ],
];

const children = commands.map((args) =>
  spawn(executable, args, { env: childEnvironment, stdio: "inherit" })
);

function stop(signal = "SIGTERM") {
  for (const child of children) child.kill(signal);
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    stop(signal);
    process.exit(0);
  });
}

const result = await Promise.race(
  children.map(
    (child) =>
      new Promise((resolve) => {
        child.on("exit", (code, signal) =>
          resolve({ code: code ?? 1, signal })
        );
        child.on("error", (error) => resolve({ code: 1, error }));
      })
  )
);

stop();
if (result.error) console.error(result.error);
if (result.signal) console.error(`Example process stopped by ${result.signal}`);
process.exit(result.code);
