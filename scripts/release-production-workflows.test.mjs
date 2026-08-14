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

  for (const [job, workflow] of [
    ["deploy-api-production", "deploy-sdp-api-gcp-prod.yml"],
    ["deploy-web-production", "deploy-sdp-web-vercel-prod.yml"],
  ]) {
    assert.match(
      releaseWorkflow,
      new RegExp(
        `${job}:[\\s\\S]*needs: publish-release[\\s\\S]*uses: \\.\\/.github/workflows/${workflow}[\\s\\S]*release_sha: \\$\\{\\{ needs\\.publish-release\\.outputs\\.release_sha \\}\\}[\\s\\S]*release_tag: \\$\\{\\{ needs\\.publish-release\\.outputs\\.release_tag \\}\\}`
      )
    );
  }

  assert.doesNotMatch(releaseWorkflow, /secrets:\s+inherit/);
});

test("web production deploys run from main and verify automatic release identity", () => {
  assert.match(webWorkflow, /workflow_call:\n\s+inputs:/);
  assert.match(webWorkflow, /release_sha:\n\s+description:/);
  assert.match(webWorkflow, /release_tag:\n\s+description:/);
  assert.doesNotMatch(webWorkflow, /\n\s+release:\n/);
  assert.match(webWorkflow, /github\.ref == 'refs\/heads\/main'/);
  assert.match(
    webWorkflow,
    /ref: \$\{\{ inputs\.release_sha != '' && inputs\.release_sha \|\| inputs\.ref \}\}/
  );
  assert.match(webWorkflow, /\.github\/scripts\/verify-release-identity\.sh/);
});
