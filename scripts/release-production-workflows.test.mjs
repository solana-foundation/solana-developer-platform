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
const webVercelConfig = JSON.parse(
  fs.readFileSync(path.resolve(here, "../apps/sdp-web/vercel.json"), "utf8")
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

// Web production deploys are Vercel-git-triggered and gated by the ignore
// command: main builds only when the commit author is the release-please app,
// so a release merge is the only push that reaches production.
test("the web ignore command gates production builds on the release bot", () => {
  const gate = webVercelConfig.ignoreCommand;

  assert.match(gate, /"\$VERCEL_GIT_COMMIT_REF" = main \] \|\| exit 1/);
  assert.match(gate, /"\$VERCEL_GIT_COMMIT_AUTHOR_LOGIN" = "sdp-release-bot\[bot\]" \] && exit 1/);
  assert.match(gate, /exit 0'$/);
  assert.doesNotMatch(releaseWorkflow, /deploy-web-production:/);
});
