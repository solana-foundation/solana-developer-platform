import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isEarnDocsPreview } from "@/lib/earn-docs-preview.mjs";
import { stageEarnDocsPreview } from "./lib/earn-docs-preview";

const root = fileURLToPath(new URL("../", import.meta.url));

async function run(args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("pnpm", args, { cwd: root, stdio: "inherit", shell: false });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`pnpm ${args.join(" ")} failed with code ${code ?? -1}`));
    });
  });
}

async function main(): Promise<void> {
  // A cached checkout cannot carry a prior preview's authored files into a
  // different build. Normal generation restores the held public artifacts.
  await run(["generate:api"]);
  if (isEarnDocsPreview()) {
    await run([
      "-C",
      "../sdp-api",
      "exec",
      "node",
      "--import",
      "tsx",
      "scripts/generate-earn-reference-preview.ts",
    ]);
    await stageEarnDocsPreview(root);
    await run(["exec", "tsx", "scripts/generate-api-docs.mjs"]);
    await run(["exec", "tsx", "scripts/generate-guide-api-examples.ts"]);
    await run(["exec", "tsx", "scripts/generate-postman-collection.mjs"]);
    console.log("Including partner Earn docs only in the earn-docs Vercel preview.");
  }
  await run(["generate:ai"]);
  await run(["generate:source"]);
  // Keep staged MDX through deployment packaging: Markdown routes read it.
  await run(["exec", "next", "build"]);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
