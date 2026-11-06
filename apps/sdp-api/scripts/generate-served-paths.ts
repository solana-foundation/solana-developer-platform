import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { SDP_RAMP_PROVIDER_MATURITY } from "@sdp/types/release-channels";

import { createApp } from "@/app";
import { servedPaths } from "@/routes/served-paths";

// sdp-infra vendors this file to build the public load balancers' path
// allowlist. `--check` fails on drift.
const outputPath = path.resolve(process.cwd(), "src/routes/served-paths.generated.json");
const app = createApp({
  rampProviderMaturity: SDP_RAMP_PROVIDER_MATURITY,
});
const next = `${JSON.stringify(servedPaths(app), null, 2)}\n`;

if (process.argv.includes("--check")) {
  const current = await readFile(outputPath, "utf8");
  if (current !== next) {
    console.error(`${outputPath} is stale. Run: pnpm -C apps/sdp-api served-paths:generate`);
    process.exit(1);
  }
  console.log("Served paths are current.");
} else {
  await writeFile(outputPath, next, "utf8");
  console.log(`Served paths generated at ${outputPath}`);
}
