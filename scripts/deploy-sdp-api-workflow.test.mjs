import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const workflowPath = path.resolve(here, "../.github/workflows/deploy-sdp-api.yml");

test("legacy Cloudflare deploy is production-only", () => {
  const workflow = fs.readFileSync(workflowPath, "utf8");

  assert.doesNotMatch(workflow, /^\s+branches:/m);
  assert.match(workflow, /^\s+- v\*\.\*\.\*$/m);
  assert.match(workflow, /^\s+- solana-developer-platform-v\*\.\*\.\*$/m);
  assert.doesNotMatch(workflow, /^\s+environment:\s*$/m);
  assert.match(workflow, /^\s+environment: production$/m);
  assert.match(workflow, /^\s+TARGET_ENV: production$/m);
  assert.match(workflow, /^\s+DOPPLER_CONFIG_NAME: prd$/m);
  assert.match(workflow, /description: "Existing release tag to deploy"/);
  assert.match(workflow, /ref:\n\s+description:[\s\S]*?required: true/);
});
