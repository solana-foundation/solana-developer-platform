import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const workflowsDir = path.resolve(here, "../.github/workflows");
const stageDeployFile = "deploy-sdp-api-gcp-stage.yml";
const betaDeployFile = "deploy-sdp-api-gcp-beta.yml";
const betaGateContext = "sdp-web beta gate";

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

function assertLine(block, line) {
  assert.ok(block.split("\n").includes(line), `missing line: ${line}`);
}

function steps(block) {
  return block
    .split(/\n(?= {6}- name: )/)
    .slice(1)
    .map((step) => ({
      name: step.match(/^ {6}- name: (.+)$/m)[1],
      block: step,
    }));
}

function stepBlock(block, stepName) {
  const step = steps(block).find(({ name }) => name === stepName);
  assert.ok(step, `missing step: ${stepName}`);
  return step.block;
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

function runScript(script, { stubs, env }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "beta-deploy-"));
  const output = path.join(dir, "output");
  const summary = path.join(dir, "summary.md");
  const calls = path.join(dir, "calls.log");
  for (const file of [output, summary, calls]) fs.writeFileSync(file, "");
  for (const [name, body] of Object.entries({ sleep: "exit 0", ...stubs })) {
    fs.writeFileSync(
      path.join(dir, name),
      `#!/usr/bin/env bash\nprintf '%s %s\\n' '${name}' "$*" >> '${calls}'\n${body}\n`
    );
    fs.chmodSync(path.join(dir, name), 0o755);
  }
  // Startup files can prepend system binaries ahead of the fixture stubs.
  const result = spawnSync("bash", ["--noprofile", "--norc", "-c", script], {
    env: {
      PATH: `${dir}:${process.env.PATH}`,
      GITHUB_OUTPUT: output,
      GITHUB_STEP_SUMMARY: summary,
      ...env,
    },
    encoding: "utf8",
  });
  return {
    code: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    output: fs.readFileSync(output, "utf8"),
    summary: fs.readFileSync(summary, "utf8"),
    calls: fs
      .readFileSync(calls, "utf8")
      .split("\n")
      .filter((line) => line !== ""),
  };
}

const betaJob = () => jobBlock(readWorkflow(betaDeployFile), "deploy");
const betaSmokeJob = () => jobBlock(readWorkflow(betaDeployFile), "smoke");

test("the beta workflow runs the beta steps in order", () => {
  const beta = betaJob();
  assertLine(beta, "      PROJECT_ID: solana-developer-platform-beta");
  assertLine(beta, "      REPO: sdp-beta");
  assertLine(beta, "      BETA_SERVICE: sdp-beta-api-public");
  assertLine(beta, "      BETA_WORKER_SERVICE: sdp-beta-worker");
  assertLine(beta, "      BETA_MIGRATE_JOB: sdp-beta-api-public-migrate");
  assertLine(beta, "      BETA_ORIGIN: https://api-beta.solana.com");
  assert.deepEqual(
    steps(beta).map(({ name }) => name),
    [
      "Checkout",
      "Authenticate to GCP",
      "Set up gcloud",
      "Find beta resources",
      "Configure Docker for Artifact Registry",
      "Install Cosign",
      "Install crane",
      "Log in to GHCR",
      "Verify and promote merge image",
      "Resolve immutable deploy image",
      "Run beta database migrations",
      "Deploy beta service",
      "Verify beta revision readiness",
      "Check the beta release channel",
      "Update beta worker image",
      "Post the sdp-web beta gate status",
      "Install Doppler CLI",
      "Doppler OIDC login",
      "Notify Slack — beta deploy failed",
    ]
  );
  const chain = [
    ["Configure Docker for Artifact Registry", "steps.find.outputs.present == 'true'"],
    ["Install Cosign", "steps.docker.outcome == 'success'"],
    ["Install crane", "steps.cosign.outcome == 'success'"],
    ["Log in to GHCR", "steps.crane.outcome == 'success'"],
    ["Verify and promote merge image", "steps.ghcr.outcome == 'success'"],
    ["Resolve immutable deploy image", "steps.promote.outcome == 'success'"],
    ["Run beta database migrations", "steps.image.outcome == 'success'"],
    ["Deploy beta service", "steps.migrate.outcome == 'success'"],
    ["Verify beta revision readiness", "steps.service.outcome == 'success'"],
    ["Check the beta release channel", "steps.ready.outcome == 'success'"],
    ["Update beta worker image", "steps.channel.outcome == 'success'"],
    ["Post the sdp-web beta gate status", "steps.worker.outcome == 'success'"],
  ];
  for (const [stepName, condition] of chain) {
    assertLine(stepBlock(beta, stepName), `        if: ${condition}`);
  }
  for (const stepName of [
    "Run beta database migrations",
    "Deploy beta service",
    "Update beta worker image",
  ]) {
    assertLine(
      stepBlock(beta, stepName),
      `          IMAGE: ${expression("steps.image.outputs.image")}`
    );
  }
  assert.match(
    stepBlock(beta, "Check the beta release channel"),
    /"\$\{BETA_ORIGIN\}\/health" \| jq -er '\.releaseChannel'/
  );
  assert.match(
    stepBlock(beta, "Check the beta release channel"),
    /\[\[ "\$\{channel\}" == "beta" \]\]/
  );
});

test("beta authenticates as its own deployer and promotes the merge image the way prod does", () => {
  const workflow = readWorkflow(betaDeployFile);
  const beta = betaJob();
  const auth = stepBlock(beta, "Authenticate to GCP");
  assertLine(
    auth,
    `          workload_identity_provider: ${expression("vars.BETA_DEPLOY_WIF_PROVIDER")}`
  );
  assertLine(auth, `          service_account: ${expression("vars.BETA_DEPLOY_SA")}`);
  assert.doesNotMatch(workflow, /STAGE_DEPLOY|sdp-stage|developer-platform-stg/);
  // Scripts that run with the deploy credentials come from the run's ref, never from image_sha.
  assert.doesNotMatch(workflow, /\n\s+ref:/);
  // The deployer's token is pinned to main with no GitHub environment.
  assert.doesNotMatch(workflow, /\n\s+environment:/);
  assert.match(beta, /\n {4}permissions:\n(?: {6}.+\n)* {6}packages: read\n/);

  const prod = jobBlock(readWorkflow("deploy-sdp-api-gcp-prod.yml"), "deploy");
  const runOf = (block, name) => runBlock(stepBlock(block, name));
  assert.equal(
    // Beta hands the digest on as a step output; prod sets it in the job env.
    runOf(beta, "Verify and promote merge image")
      .replace('echo "src_digest=', 'echo "SRC_DIGEST=')
      .replace('"$' + '{GITHUB_OUTPUT}"', '"$' + '{GITHUB_ENV}"'),
    runOf(prod, "Verify and promote merge image"),
    "the beta image promotion drifted from prod's"
  );
  for (const stepName of ["Install Cosign", "Install crane"]) {
    assert.equal(
      stepBlock(beta, stepName).match(/\n {8}uses: (.+)\n/)[1],
      stepBlock(prod, stepName).match(/\n {8}uses: (.+)\n/)[1]
    );
  }
  const resolve = stepBlock(beta, "Resolve immutable deploy image");
  assert.match(resolve, /\[\[ "\$\{digest\}" != "\$\{SRC_DIGEST\}" \]\]/);
  assertLine(resolve, `          SRC_DIGEST: ${expression("steps.promote.outputs.src_digest")}`);
});

test("a beta failure stays in its job: every job and step continues on error within a timeout", () => {
  for (const [label, block] of [
    ["deploy beta", betaJob()],
    ["beta smoke", betaSmokeJob()],
  ]) {
    assertLine(block, "    continue-on-error: true");
    let stepMinutes = 0;
    for (const step of steps(block)) {
      assertLine(step.block, "        continue-on-error: true");
      const timeout = step.block.match(/\n {8}timeout-minutes: (\d+)\n/);
      assert.ok(timeout, `${label} step "${step.name}" has no timeout`);
      stepMinutes += Number(timeout[1]);
    }
    assert.ok(steps(block).length > 0, `${label} has no steps`);
    // A hung step must fail on its own and continue; a job timeout would fail the job.
    const jobMinutes = Number(block.match(/\n {4}timeout-minutes: (\d+)\n/)[1]);
    assert.ok(stepMinutes < jobMinutes, `${label} steps can outlast the job timeout`);
  }
});

test("beta is dispatched as its own run after a green stage deploy and smoke", () => {
  const deployWorkflow = readWorkflow("deploy.yml");
  const betaCaller = jobBlock(deployWorkflow, "dispatch-api-beta");
  assertLine(betaCaller, "    needs: deploy-api-stage");
  assert.match(
    betaCaller,
    /\n {4}if: >-\n {6}needs\.deploy-api-stage\.result == 'success' &&\n {6}vars\.BETA_DEPLOY_WIF_PROVIDER != '' && vars\.BETA_DEPLOY_SA != ''\n/
  );
  assertLine(betaCaller, "    continue-on-error: true");
  // A called workflow would hold this run's concurrency slot, and with it the next merge's deploy.
  assert.doesNotMatch(betaCaller, /\n {4}uses: /);
  assert.match(betaCaller, /\n {4}permissions:\n {6}actions: write\n {4}steps:/);
  assertLine(
    betaCaller,
    `        run: gh workflow run ${betaDeployFile} --repo "${expression("github.repository")}" --ref main -f image_sha="${expression("github.sha")}"`
  );
  const betaWorkflow = readWorkflow(betaDeployFile);
  assert.doesNotMatch(betaWorkflow, /workflow_call/);
  assert.match(betaWorkflow, /\n {2}workflow_dispatch:\n {4}inputs:\n {6}image_sha:\n/);
  assertLine(betaWorkflow, "  group: sdp-api-gcp-deploy-beta");
  assertLine(betaWorkflow, "  cancel-in-progress: false");
  assert.match(betaJob(), /\n {4}permissions:\n(?: {6}.+\n)* {6}statuses: write\n/);
  // The migration approval run requires every job under the stage caller's name to succeed.
  const stageName = jobBlock(deployWorkflow, "deploy-api-stage").match(/\n {4}name: (.+)\n/)[1];
  const betaName = betaCaller.match(/\n {4}name: (.+)\n/)[1];
  assert.ok(!betaName.startsWith(stageName), `${betaName} falls under the stage gate`);
  assert.ok(
    readWorkflow("apply-prod-migrations.yml").includes(`startswith("${stageName}")`),
    "the approval run no longer gates on the stage job name"
  );

  for (const jobName of ["schema", "deploy-api-prod", "request-schema-approval", "notify-end"]) {
    assert.doesNotMatch(
      jobBlock(deployWorkflow, jobName),
      /needs:.*dispatch-api-beta/,
      `${jobName} waits on beta`
    );
  }
  assert.doesNotMatch(jobBlock(deployWorkflow, "deploy-api-stage"), /statuses: write/);
  assert.doesNotMatch(readWorkflow(stageDeployFile), /beta/i);
  assert.doesNotMatch(readWorkflow("sdp-stage-smoke.yml"), /beta/i);
  for (const fileName of [
    "deploy-sdp-api-gcp-prod.yml",
    "apply-prod-migrations.yml",
    "rollback-sdp-api-gcp-prod.yml",
  ]) {
    assert.doesNotMatch(readWorkflow(fileName), /beta/i, `${fileName} mentions beta`);
  }
  assert.match(jobBlock(deployWorkflow, "changes"), /\(-prod\|-stage\|-beta\)/);
});

test("the beta smoke follows a deploy that found beta, asserts the channel and reports to Loki as target beta", () => {
  const betaSmoke = betaSmokeJob();
  assertLine(betaSmoke, "    needs: deploy");
  assertLine(betaSmoke, "    if: needs.deploy.outputs.present == 'true'");
  assertLine(betaSmoke, "      SMOKE_TARGET: beta");
  assert.deepEqual(
    steps(betaSmoke).map(({ name }) => name),
    [
      "Checkout",
      "Probe the beta API",
      "Install Doppler CLI",
      "Doppler OIDC login",
      "Report beta run to Loki",
    ]
  );
  assert.match(stepBlock(betaSmoke, "Probe the beta API"), /jq -e '\.releaseChannel == "beta"'/);
  const loki = stepBlock(betaSmoke, "Report beta run to Loki");
  assertLine(loki, `          SMOKE_OUTCOME: ${expression("steps.smoke.outcome")}`);
  assert.match(
    loki,
    /--preserve-env=SMOKE_OUTCOME,SMOKE_TARGET,RUN_ID,RUN_URL -- \.\/scripts\/report-smoke-to-loki\.sh/
  );
});

const findScript = () => runBlock(stepBlock(betaJob(), "Find beta resources"));
const findEnv = {
  DEPLOY_IMAGE_SHA: "b".repeat(40),
  REGION: "us-central1",
  PROJECT_ID: "example-project",
  BETA_SERVICE: "sdp-beta-api-public",
  BETA_WORKER_SERVICE: "sdp-beta-worker",
  BETA_MIGRATE_JOB: "sdp-beta-api-public-migrate",
};

test("the beta deploy skips without failing while a beta resource is not found", () => {
  const run = runScript(findScript(), {
    stubs: {
      gcloud: `if [[ "$4" == sdp-beta-worker ]]; then echo "ERROR: (gcloud.run.services.describe) Cannot find service [sdp-beta-worker]" >&2; exit 1; fi; exit 0`,
    },
    env: findEnv,
  });
  assert.equal(run.code, 0, run.stderr);
  assert.equal(run.output, "present=false\n");
  assert.match(run.stdout, /missing: sdp-beta-worker/);
});

test("the beta deploy refuses an image_sha that is not a full commit SHA", () => {
  const run = runScript(findScript(), {
    stubs: { gcloud: "exit 0" },
    env: { ...findEnv, DEPLOY_IMAGE_SHA: "main" },
  });
  assert.equal(run.code, 1);
  assert.equal(run.output, "");
  assert.deepEqual(run.calls, []);
});

test("the beta deploy fails on any other describe error", () => {
  const run = runScript(findScript(), {
    stubs: { gcloud: `echo "ERROR: PERMISSION_DENIED" >&2; exit 1` },
    env: findEnv,
  });
  assert.equal(run.code, 1);
  assert.equal(run.output, "");
  assert.match(run.stderr, /PERMISSION_DENIED/);
});

test("the beta deploy records the digest it replaces", () => {
  const run = runScript(findScript(), {
    stubs: {
      gcloud: `case "$*" in
  *"revisions describe"*) echo "sha256:previous" ;;
  *latestReadyRevisionName*) echo "sdp-beta-api-public-00007-abc" ;;
esac`,
    },
    env: findEnv,
  });
  assert.equal(run.code, 0, run.stderr);
  assert.equal(run.output, "present=true\n");
  assert.match(run.summary, /sdp-beta-api-public-00007-abc \(sha256:previous\)/);
});

const repository = "example-org/example-repo";
const imageSha = "a".repeat(40);
const deployedRevision = "sdp-beta-api-public-00042-abc";
const gatePost = `gh api repos/${repository}/statuses/${imageSha} -f state=success -f context=${betaGateContext} -f description=Beta API serves this commit`;

function runGate({ serving, ghExitCode = 0 }) {
  const curl = serving
    ? `printf '%s' '${JSON.stringify({ status: "ready", revision: serving })}'`
    : "exit 22";
  const run = runScript(runBlock(stepBlock(betaJob(), "Post the sdp-web beta gate status")), {
    stubs: { curl, gh: `exit ${ghExitCode}` },
    env: {
      BETA_ORIGIN: "https://api-beta.solana.com",
      GITHUB_REPOSITORY: repository,
      IMAGE_SHA: imageSha,
      DEPLOYED_REVISION: deployedRevision,
    },
  });
  return { ...run, posts: run.calls.filter((call) => call.startsWith("gh ")) };
}

test("the beta gate posts once when beta serves the deployed revision", () => {
  const run = runGate({ serving: deployedRevision });
  assert.equal(run.code, 0, run.stderr);
  assert.deepEqual(run.posts, [gatePost]);
});

test("the beta gate stays unposted when beta serves another revision", () => {
  const run = runGate({ serving: "sdp-beta-api-public-00043-def" });
  assert.equal(run.code, 0, run.stderr);
  assert.deepEqual(run.posts, []);
  assert.match(run.summary, /leaving its web held/);
});

test("the beta gate fails without posting when the serving revision cannot be read", () => {
  const run = runGate({ serving: null });
  assert.equal(run.code, 1);
  assert.deepEqual(run.posts, []);
});

test("only the beta workflow posts the beta gate", () => {
  const posters = fs
    .readdirSync(workflowsDir)
    .filter((fileName) => readWorkflow(fileName).includes(betaGateContext));
  assert.deepEqual(posters, [betaDeployFile]);
});
