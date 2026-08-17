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
const webWorkflow = fs.readFileSync(
  path.resolve(here, "../.github/workflows/deploy-sdp-web-vercel-prod.yml"),
  "utf8"
);

function assertVercelProductionStep(
  workflow,
  buildStepName = "Build and deploy production artifact"
) {
  const stepStart = workflow.indexOf(`      - name: ${buildStepName}`);

  assert.notEqual(stepStart, -1);
  assert.doesNotMatch(workflow.slice(0, stepStart), /secrets\.VERCEL_/);
  const step = workflow.slice(stepStart);
  for (const secret of ["VERCEL_ORG_ID", "VERCEL_PROJECT_ID", "VERCEL_TOKEN"]) {
    assert.match(step, new RegExp(`${secret}: \\$\\{\\{ secrets\\.${secret} \\}\\}`));
    assert.match(step, new RegExp(`:\\s+"\\$\\{${secret}:\\?${secret} is not configured`));
  }
  assert.match(step, /vercel pull --yes --environment=production/);
  assert.match(step, /vercel build --prod/);
  assert.match(step, /vercel deploy --prebuilt --prod/);
}

// vercel build shells out to pnpm. Without this step the job dies on
// "spawn pnpm ENOENT" after pulling env vars, which is what broke the
// v0.62.0 dashboard deploy. Assert the setup exists and precedes the build.
function assertPnpmSetupPrecedesBuild(workflow, buildStepName) {
  const pnpmSetup = workflow.indexOf("      - name: Setup pnpm");
  const stepStart = workflow.indexOf(`      - name: ${buildStepName}`);

  assert.notEqual(pnpmSetup, -1, "the Vercel build job must set up pnpm");
  assert.notEqual(stepStart, -1);
  assert.ok(pnpmSetup < stepStart, "pnpm must be installed before vercel build runs");
  assert.match(workflow.slice(pnpmSetup, stepStart), /uses: pnpm\/action-setup@[0-9a-f]{40}/);
}

test("release publication passes an immutable identity to both production deployments", () => {
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

  const webJob = releaseWorkflow.slice(releaseWorkflow.indexOf("  deploy-web-production:"));

  assert.match(webJob, /needs: publish-release/);
  assert.doesNotMatch(webJob, /uses: \.\/\.github\/workflows\//);
  assert.match(webJob, /environment: production/);
  assert.match(webJob, /github\.ref == 'refs\/heads\/main'/);
  assert.match(webJob, /ref: \$\{\{ needs\.publish-release\.outputs\.release_sha \}\}/);
  assert.match(
    webJob,
    /verify-release-identity\.sh[\s\S]*needs\.publish-release\.outputs\.release_tag[\s\S]*needs\.publish-release\.outputs\.release_sha/
  );
  assertVercelProductionStep(webJob);
  assertPnpmSetupPrecedesBuild(webJob, "Build and deploy production artifact");

  assert.doesNotMatch(releaseWorkflow, /secrets:\s+inherit/);
});

test("manual web production deploys remain protected and use environment secrets", () => {
  assert.doesNotMatch(webWorkflow, /workflow_call:/);
  assert.match(webWorkflow, /workflow_dispatch:/);
  assert.doesNotMatch(webWorkflow, /\n\s+release:\n/);
  assert.match(webWorkflow, /github\.ref == 'refs\/heads\/main'/);
  assert.match(webWorkflow, /environment: production/);
  assert.match(webWorkflow, /ref: \$\{\{ inputs\.ref \}\}/);
  assertVercelProductionStep(webWorkflow, "Build production artifact");
  assertPnpmSetupPrecedesBuild(webWorkflow, "Build production artifact");
  assert.doesNotMatch(webWorkflow, /secrets:\s+inherit/);
});

test("the manual web deploy can build without deploying", () => {
  assert.match(webWorkflow, /dry_run:\n\s+description:[\s\S]*type: boolean/);
  assert.match(webWorkflow, /default: false/);

  // The deploy must be the only thing the dry run skips: pull and build stay
  // in an unconditional step so a dry run exercises the real build path.
  const buildStep = webWorkflow.slice(
    webWorkflow.indexOf("      - name: Build production artifact"),
    webWorkflow.indexOf("      - name: Skip deploy (dry run)")
  );
  assert.doesNotMatch(buildStep, /^\s+if:/m);
  assert.match(buildStep, /vercel pull --yes --environment=production/);
  assert.match(buildStep, /vercel build --prod/);

  const deployStep = webWorkflow.slice(
    webWorkflow.indexOf("      - name: Deploy production artifact")
  );
  assert.match(deployStep, /if: \$\{\{ !inputs\.dry_run \}\}/);
  assert.match(deployStep, /vercel deploy --prebuilt --prod/);
});
