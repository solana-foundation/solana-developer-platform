import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const workflowsDir = path.resolve(here, "../.github/workflows");
const prodDeployFile = "deploy-sdp-api-gcp-prod.yml";
const webGateContext = "sdp-web production gate";

function readWorkflow(fileName) {
  return fs.readFileSync(path.join(workflowsDir, fileName), "utf8");
}

function expression(body) {
  return ["$", "{{ ", body, " }}"].join("");
}

function jobBlocks(workflow) {
  const jobsSection = workflow.slice(workflow.indexOf("\njobs:\n"));
  const headers = [...jobsSection.matchAll(/^ {2}([a-z][\w-]*):$/gm)];
  return new Map(
    headers.map((header, index) => [
      header[1],
      jobsSection.slice(
        header.index,
        index + 1 < headers.length ? headers[index + 1].index : jobsSection.length
      ),
    ])
  );
}

function jobBlock(workflow, jobName) {
  const block = jobBlocks(workflow).get(jobName);
  assert.ok(block, `missing job: ${jobName}`);
  return block;
}

function permissionLines(block) {
  const permissions = block.match(/\n {4}permissions:\n((?: {6}.+\n)+)/);
  assert.ok(permissions, "job declares no permissions");
  return permissions[1]
    .trimEnd()
    .split("\n")
    .map((line) => line.trim());
}

function assertLine(block, line) {
  assert.ok(block.split("\n").includes(line), `missing line: ${line}`);
}

function stepBlock(block, stepName) {
  const start = block.indexOf(`      - name: ${stepName}\n`);
  assert.notEqual(start, -1, `missing step: ${stepName}`);
  const next = block.indexOf("\n      - ", start + 1);
  return block.slice(start, next === -1 ? block.length : next);
}

test("the production API deploy releases the sdp-web production gate for the deployed merge commit", () => {
  const releaseWeb = jobBlock(readWorkflow(prodDeployFile), "release-web");

  assertLine(releaseWeb, "    needs: deploy");
  assertLine(
    releaseWeb,
    `    if: ${expression("!cancelled() && needs.deploy.result == 'success' && github.run_attempt == 1 && inputs.image_sha != '' && (github.event_name != 'workflow_dispatch' || inputs.approved_schema)")}`
  );
  assertLine(releaseWeb, "    timeout-minutes: 3");
  assert.deepEqual(permissionLines(releaseWeb), ["statuses: write"]);
  assertLine(releaseWeb, `          IMAGE_SHA: ${expression("inputs.image_sha")}`);
  assert.match(
    releaseWeb,
    /\n {10}for attempt in 1 2 3; do\n {12}if gh api "repos\/\$\{GITHUB_REPOSITORY\}\/statuses\/\$\{IMAGE_SHA\}" \\\n\s+-f state=success -f context="sdp-web production gate"[\s\S]*\n {10}done\n/
  );
  assert.ok(
    releaseWeb.trimEnd().endsWith("\n          exit 1"),
    "release-web does not fail after retries"
  );
});

test("the gate's prerequisite deploy job and its canary step cannot be masked as success", () => {
  const deploy = jobBlock(readWorkflow(prodDeployFile), "deploy");

  assert.doesNotMatch(deploy, /^ {4}continue-on-error:/m);
  assert.doesNotMatch(
    stepBlock(deploy, "Run prod canary against the promoted revision"),
    /continue-on-error/
  );
});

test("every production API deploy caller grants the gate status, only that workflow posts it, and every push deploys", () => {
  const workflowFiles = fs
    .readdirSync(workflowsDir)
    .filter((fileName) => fileName.endsWith(".yml") || fileName.endsWith(".yaml"));
  const callerJobs = workflowFiles.flatMap((fileName) =>
    [...jobBlocks(readWorkflow(fileName))]
      .filter(([, block]) => block.includes(`    uses: ./.github/workflows/${prodDeployFile}\n`))
      .map(([jobName, block]) => ({ fileName, jobName, block }))
  );

  assert.deepEqual(callerJobs.map(({ fileName, jobName }) => `${fileName}#${jobName}`).sort(), [
    "apply-prod-migrations.yml#deploy",
    "deploy.yml#deploy-api-prod",
  ]);
  assert.ok(!readWorkflow("release-please.yml").includes(prodDeployFile));
  for (const { fileName, jobName, block } of callerJobs) {
    assert.ok(
      permissionLines(block).includes("statuses: write"),
      `${fileName}#${jobName} lacks statuses: write`
    );
  }

  const gatePosters = workflowFiles.filter((fileName) =>
    readWorkflow(fileName).includes(webGateContext)
  );
  assert.deepEqual(gatePosters, [prodDeployFile]);

  const deployWorkflow = readWorkflow("deploy.yml");
  assert.match(
    jobBlock(deployWorkflow, "changes"),
    /\n {14}if \[ "\$EVENT_NAME" = push \] \|\| match "\^\([^"]+\)"; then\n/
  );
  assert.ok(!deployWorkflow.includes("chore(main): release"));
});
