import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (name) => fs.readFileSync(path.resolve(here, `../.github/workflows/${name}`), "utf8");
const orchestrator = read("deploy.yml");
const devWorkflow = read("deploy-sdp-api-gcp.yml");

test("the orchestrator owns the push trigger; the dev workflow is only callable", () => {
  assert.match(orchestrator, /push:\n\s+branches: \[main\]/);
  assert.doesNotMatch(devWorkflow, /\n\s+push:\n/);
  assert.match(devWorkflow, /workflow_call:/);
  assert.match(devWorkflow, /workflow_dispatch:/);
});

test("prod deploys chain behind the dev deploy and smoke of the same sha", () => {
  assert.match(orchestrator, /deploy-api-prod:\n[\s\S]*?needs: \[changes, deploy-api-dev\]/);
  assert.match(orchestrator, /uses: \.\/\.github\/workflows\/deploy-sdp-api-gcp-prod\.yml/);
  assert.match(orchestrator, /image_sha: \$\{\{ github\.sha \}\}/);
  assert.match(devWorkflow, /smoke:\n\s+name: Post-deploy dev smoke\n\s+needs: deploy/);
});

test("release-please merges are excluded from the continuous chain", () => {
  assert.match(
    orchestrator,
    /!startsWith\(github\.event\.head_commit\.message, 'chore\(main\): release'\)/
  );
});

test("service selection is path-filtered with a manual override", () => {
  assert.match(orchestrator, /git diff --name-only HEAD\^ HEAD/);
  assert.match(orchestrator, /options: \[auto, none, api\]/);
  assert.match(orchestrator, /apps\/sdp-api\//);
  assert.match(
    orchestrator,
    /concurrency:\n\s+group: sdp-deploy-main\n\s+cancel-in-progress: false/
  );
});
