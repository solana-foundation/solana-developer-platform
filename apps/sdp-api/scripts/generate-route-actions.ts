import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { SDP_RAMP_PROVIDER_MATURITY } from "@sdp/types/release-channels";

import { createApp } from "@/app";
import { routeActionsByOperation } from "@/routes/route-actions";

// The OpenAPI document reads each route's action from this file rather than
// from the app, which mounts the document (HOO-2099). `--check` fails on drift.
const outputPath = path.resolve(process.cwd(), "src/openapi/route-actions.generated.json");
const app = createApp({
  rampProviderMaturity: SDP_RAMP_PROVIDER_MATURITY,
});
const next = `${JSON.stringify(routeActionsByOperation(app), null, 2)}\n`;

if (process.argv.includes("--check")) {
  const current = await readFile(outputPath, "utf8").catch(() => "");
  if (current !== next) {
    console.error(`${outputPath} is stale. Run: pnpm -C apps/sdp-api route-actions:generate`);
    process.exit(1);
  }
  console.log("Route actions are current.");
} else {
  await writeFile(outputPath, next, "utf8");
  console.log(`Route actions generated at ${outputPath}`);
}
