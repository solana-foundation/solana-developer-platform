import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const releaseWorkflow = fs.readFileSync(
  path.resolve(here, "../.github/workflows/release-please.yml"),
  "utf8"
);

test("release publication passes an immutable identity to the production API deployment", () => {
  const publishJob = releaseWorkflow.slice(
    releaseWorkflow.indexOf("  publish-release:"),
    releaseWorkflow.indexOf("  deploy-api-production:")
  );

  assert.match(publishJob, /ref: \$\{\{ github\.sha \}\}/);
  assert.doesNotMatch(publishJob, /ref: main/);
  assert.match(
    publishJob,
    /publish-release:[\s\S]*outputs:\n\s+release_sha: \$\{\{ steps\.release\.outputs\.release_sha \}\}\n\s+release_tag: \$\{\{ steps\.release\.outputs\.release_tag \}\}/
  );
  assert.match(publishJob, /- name: Resolve published release\n\s+id: release/);
  assert.match(publishJob, /git rev-parse "\$\{release_tag\}\^\{commit\}"/);
  assert.match(publishJob, /if \[\[ "\$\{release_sha\}" != "\$\{GITHUB_SHA\}" \]\]/);

  assert.match(
    releaseWorkflow,
    /deploy-api-production:[\s\S]*needs: publish-release[\s\S]*uses: \.\/\.github\/workflows\/deploy-sdp-api-gcp-prod\.yml[\s\S]*release_sha: \$\{\{ needs\.publish-release\.outputs\.release_sha \}\}[\s\S]*release_tag: \$\{\{ needs\.publish-release\.outputs\.release_tag \}\}/
  );

  assert.doesNotMatch(releaseWorkflow, /secrets:\s+inherit/);
});

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

test("the production API deploy releases the sdp-web production gate for the deployed merge commit", () => {
  const releaseWeb = jobBlock(readWorkflow(prodDeployFile), "release-web");

  assertLine(releaseWeb, "    needs: deploy");
  assertLine(
    releaseWeb,
    `    if: ${expression("inputs.image_sha != '' && (github.event_name != 'workflow_dispatch' || inputs.approved_schema)")}`
  );
  assert.deepEqual(permissionLines(releaseWeb), ["statuses: write"]);
  assertLine(releaseWeb, `          IMAGE_SHA: ${expression("inputs.image_sha")}`);
  assert.match(
    releaseWeb,
    /gh api "repos\/\$\{GITHUB_REPOSITORY\}\/statuses\/\$\{IMAGE_SHA\}" \\\n\s+-f state=success -f context="sdp-web production gate"/
  );
});

test("every production API deploy caller grants the gate status, only that workflow posts it, and web-only merges deploy", () => {
  const workflowFiles = fs
    .readdirSync(workflowsDir)
    .filter((fileName) => fileName.endsWith(".yml"));
  const callerJobs = workflowFiles.flatMap((fileName) =>
    [...jobBlocks(readWorkflow(fileName))]
      .filter(([, block]) => block.includes(`    uses: ./.github/workflows/${prodDeployFile}\n`))
      .map(([jobName, block]) => ({ fileName, jobName, block }))
  );

  assert.deepEqual(callerJobs.map(({ fileName, jobName }) => `${fileName}#${jobName}`).sort(), [
    "apply-prod-migrations.yml#deploy",
    "deploy.yml#deploy-api-prod",
    "release-please.yml#deploy-api-production",
  ]);
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

  const detectPatterns = [
    ...jobBlock(readWorkflow("deploy.yml"), "changes").matchAll(/if match "\^\(([^"]+)\)"; then/g),
  ];
  assert.equal(detectPatterns.length, 1);
  assert.ok(detectPatterns[0][1].split("|").includes("apps/sdp-web/"));
});
