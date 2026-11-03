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
const smokeFile = "sdp-stage-smoke.yml";
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
    .map((step) => ({ name: step.match(/^ {6}- name: (.+)$/m)[1], block: step }));
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

const betaJob = () => jobBlock(readWorkflow(stageDeployFile), "beta");
const betaSmokeJob = () => jobBlock(readWorkflow(smokeFile), "beta");

test("the stage deploy runs the beta steps in order after the stage worker update", () => {
  const beta = betaJob();
  assertLine(beta, "    needs: deploy");
  assertLine(beta, "      BETA_SERVICE: sdp-stage-api-beta");
  assertLine(beta, "      BETA_WORKER_SERVICE: sdp-stage-worker-beta");
  assertLine(beta, "      BETA_MIGRATE_JOB: sdp-stage-api-beta-migrate");
  assertLine(beta, "      BETA_ORIGIN: https://api-beta.solana.com");
  assert.deepEqual(
    steps(beta).map(({ name }) => name),
    [
      "Checkout",
      "Authenticate to GCP",
      "Set up gcloud",
      "Find beta resources",
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
    ["Run beta database migrations", "steps.find.outputs.present == 'true'"],
    ["Deploy beta service", "steps.migrate.outcome == 'success'"],
    ["Verify beta revision readiness", "steps.service.outcome == 'success'"],
    ["Check the beta release channel", "steps.ready.outcome == 'success'"],
    ["Update beta worker image", "steps.channel.outcome == 'success'"],
    ["Post the sdp-web beta gate status", "steps.worker.outcome == 'success'"],
  ];
  for (const [stepName, condition] of chain) {
    assertLine(stepBlock(beta, stepName), `        if: ${condition}`);
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

// The merge deploy gates prod on the stage workflow's result, and the migration approval run on
// every stage job concluding success, so no beta job or step may fail, be skipped or be needed.
test("beta can never fail, skip or gate a stage job", () => {
  const beta = betaJob();
  const betaSmoke = betaSmokeJob();
  for (const [label, block] of [
    ["deploy beta", beta],
    ["beta smoke", betaSmoke],
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
  assert.doesNotMatch(beta, /^ {4}if:/m);
  assertLine(
    betaSmoke,
    "    if: github.repository == 'solana-foundation/solana-developer-platform'"
  );
  assert.doesNotMatch(betaSmoke, /^ {4}if:.*inputs/m);

  const smoke = jobBlock(readWorkflow(stageDeployFile), "smoke");
  assertLine(smoke, "    needs: [deploy, beta]");
  assertLine(smoke, `    if: ${expression("!cancelled() && needs.deploy.result == 'success'")}`);
  assertLine(smoke, `      beta: ${expression("needs.beta.outputs.present == 'true'")}`);

  const deployWorkflow = readWorkflow("deploy.yml");
  const deployProd = jobBlock(deployWorkflow, "deploy-api-prod");
  assert.match(deployProd, /needs\.deploy-api-stage\.result == 'success'/);
  for (const fileName of [
    "deploy-sdp-api-gcp-prod.yml",
    "apply-prod-migrations.yml",
    "rollback-sdp-api-gcp-prod.yml",
  ]) {
    assert.doesNotMatch(readWorkflow(fileName), /beta/i, `${fileName} mentions beta`);
  }
  assert.match(
    jobBlock(deployWorkflow, "deploy-api-stage"),
    /\n {4}permissions:\n(?: {6}.+\n)* {6}statuses: write\n/
  );
});

test("the beta smoke asserts the channel and reports to Loki as target beta", () => {
  const betaSmoke = betaSmokeJob();
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
  REGION: "us-central1",
  PROJECT_ID: "example-project",
  REPO: "sdp-stage",
  GITHUB_SHA: "b".repeat(40),
  BETA_SERVICE: "sdp-stage-api-beta",
  BETA_WORKER_SERVICE: "sdp-stage-worker-beta",
  BETA_MIGRATE_JOB: "sdp-stage-api-beta-migrate",
};

test("the beta deploy skips without failing while a beta resource is not found", () => {
  const run = runScript(findScript(), {
    stubs: {
      gcloud: `if [[ "$4" == sdp-stage-worker-beta ]]; then echo "ERROR: (gcloud.run.services.describe) Cannot find service [sdp-stage-worker-beta]" >&2; exit 1; fi; exit 0`,
    },
    env: findEnv,
  });
  assert.equal(run.code, 0, run.stderr);
  assert.equal(run.output, "present=false\n");
  assert.match(run.stdout, /missing: sdp-stage-worker-beta/);
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

test("the beta deploy records the digest it replaces and the image to deploy", () => {
  const run = runScript(findScript(), {
    stubs: {
      gcloud: `case "$*" in
  *"revisions describe"*) echo "sha256:previous" ;;
  *latestReadyRevisionName*) echo "sdp-stage-api-beta-00007-abc" ;;
esac`,
    },
    env: findEnv,
  });
  assert.equal(run.code, 0, run.stderr);
  assert.equal(
    run.output,
    `image=us-central1-docker.pkg.dev/example-project/sdp-stage/sdp-api-public:${findEnv.GITHUB_SHA}\npresent=true\n`
  );
  assert.match(run.summary, /sdp-stage-api-beta-00007-abc \(sha256:previous\)/);
});

const repository = "example-org/example-repo";
const imageSha = "a".repeat(40);
const deployedRevision = "sdp-stage-api-beta-00042-abc";
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
  const run = runGate({ serving: "sdp-stage-api-beta-00043-def" });
  assert.equal(run.code, 0, run.stderr);
  assert.deepEqual(run.posts, []);
  assert.match(run.summary, /leaving its web held/);
});

test("the beta gate fails without posting when the serving revision cannot be read", () => {
  const run = runGate({ serving: null });
  assert.equal(run.code, 1);
  assert.deepEqual(run.posts, []);
});

test("only the stage deploy posts the beta gate", () => {
  const posters = fs
    .readdirSync(workflowsDir)
    .filter((fileName) => readWorkflow(fileName).includes(betaGateContext));
  assert.deepEqual(posters, [stageDeployFile]);
});
