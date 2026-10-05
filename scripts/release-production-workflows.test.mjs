import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
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
const apiChangesScript = fs.readFileSync(
  path.resolve(here, "../.github/scripts/sdp-api-changes.sh"),
  "utf8"
);
const hermeticGitEnv = { ...process.env, GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: "1" };
const releaseGateScript = stepRunScript(
  readWorkflow("release-sdp-web-prod.yml"),
  "Post the sdp-web production gate status for main's head"
);

function readWorkflow(fileName) {
  return fs.readFileSync(path.join(workflowsDir, fileName), "utf8");
}

function githubExpression(body) {
  return `\${{ ${body} }}`;
}

function stepRunScript(workflow, stepName) {
  const stepStart = workflow.indexOf(`- name: ${stepName}\n`);
  assert.notEqual(stepStart, -1, stepName);
  const stepLines = workflow.slice(stepStart).split("\n");
  const bodyLines = stepLines.slice(stepLines.findIndex((line) => /^\s+run: \|$/.test(line)) + 1);
  const indent = bodyLines[0].search(/\S/);
  const bodyEnd = bodyLines.findIndex((line) => line.trim() !== "" && line.search(/\S/) < indent);
  return bodyLines
    .slice(0, bodyEnd === -1 ? bodyLines.length : bodyEnd)
    .map((line) => line.slice(indent))
    .join("\n");
}

function jobBlock(workflow, jobName) {
  const jobStart = workflow.indexOf(`\n  ${jobName}:\n`);
  assert.notEqual(jobStart, -1, jobName);
  const nextJob = workflow.slice(jobStart + 1).search(/\n {2}[\w-]+:\n/);
  return nextJob === -1
    ? workflow.slice(jobStart)
    : workflow.slice(jobStart, jobStart + 1 + nextJob);
}

function jobKey(job, key) {
  const match = job.match(new RegExp(`\\n {4}${key}:(.*(?:\\n {6,}.*)*)`));
  assert.ok(match, key);
  return match[1].trim();
}

function git(repo, args) {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
    cwd: repo,
    env: hermeticGitEnv,
    encoding: "utf8",
  }).trim();
}

function commit(repo, message, filePaths) {
  for (const filePath of filePaths) {
    fs.mkdirSync(path.dirname(path.join(repo, filePath)), { recursive: true });
    fs.writeFileSync(path.join(repo, filePath), message);
  }
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "--allow-empty", "-m", message]);
  return git(repo, ["rev-parse", "HEAD"]);
}

function createSandbox(t, changesScript) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sdp-web-gate-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sandbox = {
    repo: path.join(root, "repo"),
    bin: path.join(root, "bin"),
    ghLog: path.join(root, "gh.log"),
    summary: path.join(root, "summary.md"),
  };
  fs.mkdirSync(path.join(sandbox.repo, ".github/scripts"), { recursive: true });
  fs.writeFileSync(path.join(sandbox.repo, ".github/scripts/sdp-api-changes.sh"), changesScript, {
    mode: 0o755,
  });
  fs.mkdirSync(sandbox.bin);
  fs.writeFileSync(
    path.join(sandbox.bin, "gh"),
    `#!/bin/sh\nprintf '%s\\037' "$@" >> '${sandbox.ghLog}'\nprintf '\\n' >> '${sandbox.ghLog}'\n`,
    { mode: 0o755 }
  );
  fs.writeFileSync(sandbox.ghLog, "");
  git(sandbox.repo, ["init", "-q"]);
  return sandbox;
}

function runReleaseGate(sandbox, apiSha) {
  return spawnSync("bash", ["-c", releaseGateScript], {
    cwd: sandbox.repo,
    env: {
      ...hermeticGitEnv,
      PATH: `${sandbox.bin}${path.delimiter}${process.env.PATH}`,
      GITHUB_REPOSITORY: "synthetic/repo",
      GITHUB_STEP_SUMMARY: sandbox.summary,
      API_SHA: apiSha,
      GH_TOKEN: "synthetic",
    },
    encoding: "utf8",
  });
}

function readGhCalls(sandbox) {
  return fs
    .readFileSync(sandbox.ghLog, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => line.split("\x1f").slice(0, -1));
}

const releaseGateCases = [
  {
    name: "posts for main's head when head is the deployed API commit",
    changesScript: apiChangesScript,
    succeeds: true,
    build: (repo) => {
      const apiSha = commit(repo, "base", []);
      return { apiSha, postedShas: [apiSha] };
    },
  },
  {
    name: "posts for main's head when only sdp-web changed past the deployed API commit",
    changesScript: apiChangesScript,
    succeeds: true,
    build: (repo) => {
      const apiSha = commit(repo, "base", []);
      return { apiSha, postedShas: [commit(repo, "web change", ["apps/sdp-web/x.ts"])] };
    },
  },
  {
    name: "posts nothing when main's head carries API changes past the deployed API commit",
    changesScript: apiChangesScript,
    succeeds: true,
    build: (repo) => {
      const apiSha = commit(repo, "base", []);
      commit(repo, "api change", ["apps/sdp-api/x.ts"]);
      return { apiSha, postedShas: [] };
    },
  },
  {
    name: "posts nothing when the deployed API commit is not an ancestor of main's head",
    changesScript: apiChangesScript,
    succeeds: true,
    build: (repo) => {
      commit(repo, "base", []);
      git(repo, ["checkout", "-q", "-b", "sibling"]);
      const apiSha = commit(repo, "sibling", []);
      git(repo, ["checkout", "-q", "-"]);
      return { apiSha, postedShas: [] };
    },
  },
  {
    name: "fails without posting when the API path regex is invalid",
    changesScript: apiChangesScript.replace(/grep -E '[^']*'/, "grep -E '('"),
    succeeds: false,
    build: (repo) => {
      const apiSha = commit(repo, "base", []);
      commit(repo, "web change", ["apps/sdp-web/x.ts"]);
      return { apiSha, postedShas: [] };
    },
  },
];

for (const releaseGateCase of releaseGateCases) {
  test(`sdp-web release gate ${releaseGateCase.name}`, (t) => {
    const sandbox = createSandbox(t, releaseGateCase.changesScript);
    const { apiSha, postedShas } = releaseGateCase.build(sandbox.repo);

    const result = runReleaseGate(sandbox, apiSha);

    assert.equal(result.status === 0, releaseGateCase.succeeds, result.stderr);
    assert.deepEqual(
      readGhCalls(sandbox),
      postedShas.map((sha) => [
        "api",
        `repos/synthetic/repo/statuses/${sha}`,
        "-f",
        "state=success",
        "-f",
        "context=sdp-web production gate",
        "-f",
        "description=Production API serves this commit's API",
      ])
    );
  });
}

test("every production API deploy path releases sdp-web through the shared gate workflow", () => {
  const callers = [
    {
      fileName: "deploy.yml",
      needs: "[deploy-api-prod, web-parent-gate]",
      with: `api_sha: ${githubExpression("needs.deploy-api-prod.result == 'success' && github.sha || github.event.before")}`,
    },
    {
      fileName: "apply-prod-migrations.yml",
      needs: "deploy",
      with: `api_sha: ${githubExpression("inputs.image_sha")}`,
    },
    {
      fileName: "release-please.yml",
      needs: "[publish-release, deploy-api-production]",
      with: `api_sha: ${githubExpression("needs.publish-release.outputs.release_sha")}`,
    },
  ];

  for (const caller of callers) {
    const releaseJob = jobBlock(readWorkflow(caller.fileName), "release-web-prod");
    assert.equal(jobKey(releaseJob, "uses"), "./.github/workflows/release-sdp-web-prod.yml");
    assert.equal(jobKey(releaseJob, "needs"), caller.needs);
    assert.equal(jobKey(releaseJob, "with"), caller.with);
  }
});

test("deploy.yml releases sdp-web after its API deploy or behind a released parent", () => {
  const deployWorkflow = readWorkflow("deploy.yml");
  const releaseCondition = jobKey(jobBlock(deployWorkflow, "release-web-prod"), "if");
  const parentGate = jobBlock(deployWorkflow, "web-parent-gate");

  assert.ok(
    releaseCondition.includes("needs.deploy-api-prod.result == 'success'"),
    releaseCondition
  );
  assert.ok(
    releaseCondition.includes("needs.web-parent-gate.outputs.released == 'true'"),
    releaseCondition
  );
  assert.equal(jobKey(parentGate, "needs"), "changes");
  assert.ok(jobKey(parentGate, "if").includes("needs.changes.outputs.api == 'false'"));
  assert.ok(parentGate.includes(`PARENT_SHA: ${githubExpression("github.event.before")}`));
  assert.ok(parentGate.includes('select(.context == "sdp-web production gate")'));
  assert.ok(
    jobBlock(deployWorkflow, "changes").includes('.github/scripts/sdp-api-changes.sh "$BASE" HEAD')
  );
});

test("only the shared gate workflow posts the sdp-web production gate status", () => {
  const posters = fs.readdirSync(workflowsDir).filter((fileName) => {
    const workflow = readWorkflow(fileName);
    return workflow.includes("statuses/") && workflow.includes("sdp-web production gate");
  });

  assert.deepEqual(posters, ["release-sdp-web-prod.yml"]);
});
