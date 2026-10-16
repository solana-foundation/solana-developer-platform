import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
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

function runBlock(step) {
  const marker = "        run: |\n";
  const start = step.indexOf(marker);
  assert.notEqual(start, -1, "step has no run block");
  return step
    .slice(start + marker.length)
    .split("\n")
    .map((line) => line.slice(10))
    .join("\n");
}

const imageSha = "a".repeat(40);
const deployedRevision = "sdp-prod-api-public-00042-abc";
const repository = "example-org/example-repo";
const releaseWebScript = runBlock(
  stepBlock(
    jobBlock(readWorkflow(prodDeployFile), "release-web"),
    "Post the sdp-web production gate status"
  )
);

function servingCurl(revision) {
  return `#!/usr/bin/env bash\nprintf '%s' '${JSON.stringify({ status: "ready", revision })}'\n`;
}

function runReleaseWeb({ curlScript, ghExitCode }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "release-web-"));
  const ghLog = path.join(dir, "gh.log");
  const summary = path.join(dir, "summary.md");
  fs.writeFileSync(ghLog, "");
  fs.writeFileSync(summary, "");
  const stubs = {
    curl: curlScript,
    gh: `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> '${ghLog}'\nexit ${ghExitCode}\n`,
    sleep: "#!/usr/bin/env bash\nexit 0\n",
  };
  for (const [name, script] of Object.entries(stubs)) {
    fs.writeFileSync(path.join(dir, name), script);
    fs.chmodSync(path.join(dir, name), 0o755);
  }
  const result = spawnSync("bash", ["-c", releaseWebScript], {
    env: {
      PATH: `${dir}:${process.env.PATH}`,
      GITHUB_REPOSITORY: repository,
      GITHUB_STEP_SUMMARY: summary,
      IMAGE_SHA: imageSha,
      DEPLOYED_REVISION: deployedRevision,
    },
    encoding: "utf8",
  });
  return {
    code: result.status,
    stderr: result.stderr,
    summary: fs.readFileSync(summary, "utf8"),
    posts: fs
      .readFileSync(ghLog, "utf8")
      .split("\n")
      .filter((line) => line !== ""),
  };
}

const gatePost = `api repos/${repository}/statuses/${imageSha} -f state=success -f context=${webGateContext} -f description=Production API serves this commit`;

test("the production API deploy releases the sdp-web production gate for the deployed merge commit", () => {
  const releaseWeb = jobBlock(readWorkflow(prodDeployFile), "release-web");

  assertLine(releaseWeb, "    needs: deploy");
  assertLine(
    releaseWeb,
    `    if: ${expression("!cancelled() && needs.deploy.result == 'success' && (github.event_name != 'workflow_dispatch' || inputs.approved_schema)")}`
  );
  assertLine(releaseWeb, "    timeout-minutes: 5");
  assert.deepEqual(permissionLines(releaseWeb), ["statuses: write"]);
  assertLine(releaseWeb, `          IMAGE_SHA: ${expression("inputs.image_sha")}`);
  assertLine(
    releaseWeb,
    `          DEPLOYED_REVISION: ${expression("needs.deploy.outputs.revision")}`
  );
});

test("the deploy job exposes the revision it promoted once the rollout completes", () => {
  const deploy = jobBlock(readWorkflow(prodDeployFile), "deploy");
  assertLine(deploy, `      revision: ${expression("steps.promote.outputs.revision")}`);
  const promote = stepBlock(deploy, "Promote service and cron with rollback");
  assertLine(promote, "        id: promote");
  assert.match(
    promote,
    /echo "ROLLOUT_COMPLETE=true" >> "\$\{GITHUB_ENV\}"\n\s+echo "revision=\$\{CANDIDATE_REVISION\}" >> "\$\{GITHUB_OUTPUT\}"\n/
  );
});

test("release-web posts the gate once when production serves the deployed revision", () => {
  const run = runReleaseWeb({ curlScript: servingCurl(deployedRevision), ghExitCode: 0 });
  assert.equal(run.code, 0, run.stderr);
  assert.deepEqual(run.posts, [gatePost]);
});

test("release-web leaves web held without failing when production serves another revision", () => {
  const run = runReleaseWeb({
    curlScript: servingCurl("sdp-prod-api-public-00043-def"),
    ghExitCode: 0,
  });
  assert.equal(run.code, 0, run.stderr);
  assert.deepEqual(run.posts, []);
  assert.match(run.summary, /leaving its web held/);
});

test("release-web fails without posting when the serving revision cannot be read", () => {
  const run = runReleaseWeb({ curlScript: "#!/usr/bin/env bash\nexit 22\n", ghExitCode: 0 });
  assert.equal(run.code, 1);
  assert.deepEqual(run.posts, []);
  assert.match(run.stderr, /Could not read the serving revision/);
});

test("release-web fails after three rejected gate posts", () => {
  const run = runReleaseWeb({ curlScript: servingCurl(deployedRevision), ghExitCode: 1 });
  assert.equal(run.code, 1);
  assert.deepEqual(run.posts, [gatePost, gatePost, gatePost]);
  assert.match(run.stderr, /Could not post the sdp-web production gate/);
});

test("a deploy whose web release did not succeed reports web-held", () => {
  const notifyResult = jobBlock(readWorkflow(prodDeployFile), "notify-result");
  assertLine(notifyResult, "    needs: [deploy, release-web]");
  assert.match(
    notifyResult,
    /needs\.deploy\.result == 'success' && \(needs\.release-web\.result == 'success' \|\| needs\.release-web\.result == 'skipped'\) && 'success' \|\|\n\s+needs\.deploy\.result == 'success' && 'web-held' \|\|\n\s+needs\.deploy\.result == 'cancelled' && 'cancelled' \|\|/
  );
  assert.match(
    fs.readFileSync(path.join(here, "notify-slack.sh"), "utf8"),
    /\n {2}web-held\) MARKER=/
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
