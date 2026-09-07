import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const workflowPath = path.resolve(here, "../.github/workflows/deploy-sdp-api-gcp-prod.yml");
const workflow = fs.readFileSync(workflowPath, "utf8");

test("manual production deploy requires an immutable SHA-tagged image", () => {
  assert.match(
    workflow,
    /image_sha:\n\s+description: "Existing 40-character Git SHA image tag to redeploy[^\n]*"\n\s+type: string\n\s+required: true/
  );
  assert.match(workflow, /\^\[0-9a-f\]\{40\}\$/);
  assert.match(workflow, /gcloud artifacts docker images describe "\$\{tagged_image\}"/);
  assert.match(workflow, /image_summary\.fully_qualified_digest/);
  assert.match(workflow, /\^sha256:\[0-9a-f\]\{64\}\$/);
});

test("automatic production deploys are called from the protected main release flow", () => {
  assert.match(workflow, /workflow_call:\n\s+inputs:/);
  assert.match(workflow, /release_sha:\n\s+description:/);
  assert.match(workflow, /release_tag:\n\s+description:/);
  assert.doesNotMatch(workflow, /\n\s+release:\n/);
  assert.match(workflow, /github\.ref == 'refs\/heads\/main'/);
  assert.match(workflow, /\.github\/scripts\/verify-release-identity\.sh/);
});

test("release deploys verify and promote the signed image; manual redeploys skip migrations", () => {
  assert.doesNotMatch(workflow, /run_migrations:/);
  assert.doesNotMatch(workflow, /docker build/);
  assert.match(
    workflow,
    /- name: Verify and promote release image\n\s+if: \$\{\{ inputs\.release_sha != '' \}\}/
  );
  assert.match(
    workflow,
    /- name: Run database migrations\n\s+if: \$\{\{ inputs\.release_sha != '' \}\}/
  );
  assert.match(workflow, /cosign verify "\$\{SRC_BASE\}@\$\{SRC_DIGEST\}"/);
  assert.match(workflow, /cosign copy --force "\$\{SRC_BASE\}@\$\{SRC_DIGEST\}"/);
  assert.match(workflow, /--certificate-github-workflow-sha "\$\{DEPLOY_IMAGE_SHA\}"/);
  assert.match(workflow, /\$\{DEST_BASE\}:\$\{DEPLOY_IMAGE_SHA\}/);
});

test("manual redeploys verify the promoted image signature before rollout", () => {
  assert.match(
    workflow,
    /- name: Verify rollback image signature\n\s+if: \$\{\{ github\.event_name == 'workflow_dispatch' \}\}/
  );
});

test("candidate is revision-specific and Cloud Run-ready before promotion", () => {
  assert.match(workflow, /echo "IMAGE=\$\{resolved_image\}" >> "\$\{GITHUB_ENV\}"/);
  assert.match(workflow, /--no-traffic --tag "\$\{candidate_tag\}"/);
  assert.match(workflow, /CANDIDATE_TAG=\$\{candidate_tag\}/);
  assert.match(workflow, /status\.imageDigest/);
  assert.match(
    workflow,
    /gcloud run revisions describe "\$\{CANDIDATE_REVISION\}"[\s\S]*--format=json/
  );
  assert.match(workflow, /\.status\.conditions\[\]/);
  assert.doesNotMatch(workflow, /CANDIDATE_URL/);
  assert.match(workflow, /\.revision == \$revision/);
  assert.match(workflow, /\.checks\.database == "ok"/);
  assert.match(workflow, /\.checks\.redis == "ok"/);

  const candidateDeploy = workflow.indexOf("- name: Deploy candidate without production traffic");
  const candidateReadiness = workflow.indexOf("- name: Verify candidate revision readiness");
  const promotion = workflow.indexOf("- name: Promote service and cron with rollback");
  assert.ok(candidateDeploy !== -1 && candidateDeploy < candidateReadiness);
  assert.ok(candidateReadiness < promotion);
});

test("candidate traffic tag is always removed", () => {
  assert.match(workflow, /- name: Remove candidate traffic tag\n\s+if: \$\{\{ always\(\) \}\}/);
  assert.match(workflow, /--remove-tags "\$\{CANDIDATE_TAG\}"/);

  const promotion = workflow.indexOf("- name: Promote service and cron with rollback");
  const cleanup = workflow.indexOf("- name: Remove candidate traffic tag");
  assert.ok(promotion !== -1 && promotion < cleanup);
});

test("managed cadence parity is verified before production promotion", () => {
  const promotionStep = workflow.indexOf("- name: Promote service and cron with rollback");
  const cadenceVerification = workflow.indexOf(
    "verify-managed-reconciliation-cadence.mjs",
    promotionStep
  );
  const trafficPromotion = workflow.indexOf("--to-revisions", promotionStep);
  const cronUpdate = workflow.indexOf("gcloud run jobs update", promotionStep);

  assert.ok(promotionStep !== -1 && promotionStep < cadenceVerification);
  assert.ok(cadenceVerification < trafficPromotion);
  assert.ok(cadenceVerification < cronUpdate);
});

test("cancellation-safe rollback restores resolved traffic and cron together", () => {
  assert.match(workflow, /if: >-\n\s+always\(\) &&/);
  assert.match(workflow, /PREVIOUS_TRAFFIC=/);
  assert.match(workflow, /PREVIOUS_CRON_IMAGE=/);
  assert.match(
    workflow,
    /--format='value\(spec\.template\.spec\.template\.spec\.containers\[0\]\.image\)'/
  );
  assert.match(workflow, /ROLLOUT_STARTED=true/);
  assert.match(workflow, /ROLLOUT_COMPLETE=true/);
  assert.match(
    workflow,
    /- name: Roll back incomplete rollout\n\s+if: \$\{\{ always\(\) \}\}\n\s+timeout-minutes: 5/
  );
  assert.match(workflow, /--to-revisions "\$\{CANDIDATE_REVISION\}=100"/);
  assert.match(workflow, /--to-revisions "\$\{PREVIOUS_TRAFFIC\}"/);
  assert.match(workflow, /--image "\$\{PREVIOUS_CRON_IMAGE\}"/);

  const candidateStep = workflow.indexOf("- name: Deploy candidate without production traffic");
  const rolloutStarted = workflow.indexOf("ROLLOUT_STARTED=true", candidateStep);
  const candidateDeploy = workflow.indexOf("gcloud run services update", candidateStep);
  const promotionStep = workflow.indexOf("- name: Promote service and cron with rollback");
  const promotion = workflow.indexOf("--to-revisions", promotionStep);
  const canonicalReadiness = workflow.indexOf('"https://api.solana.com/health/ready"', promotion);
  const cronUpdate = workflow.indexOf("gcloud run jobs update", canonicalReadiness);
  const rolloutComplete = workflow.indexOf("ROLLOUT_COMPLETE=true", cronUpdate);
  const rollback = workflow.indexOf("- name: Roll back incomplete rollout", rolloutComplete);
  assert.ok(candidateStep !== -1 && candidateStep < rolloutStarted);
  assert.ok(rolloutStarted < candidateDeploy);
  assert.ok(promotion !== -1 && promotion < canonicalReadiness);
  assert.ok(canonicalReadiness < cronUpdate);
  assert.ok(cronUpdate < rolloutComplete && rolloutComplete < rollback);
});

test("rollback targets resolved pre-candidate revisions instead of LATEST", () => {
  const capture = workflow.indexOf("- name: Capture rollback state");
  const candidate = workflow.indexOf("- name: Deploy candidate without production traffic");
  const captureStep = workflow.slice(capture, candidate);

  assert.match(captureStep, /\.status\.traffic\[\]/);
  assert.match(captureStep, /\.revisionName/);
  assert.doesNotMatch(captureStep, /LATEST=/);
});

test("service and cron use the resolved digest", () => {
  assert.match(
    workflow,
    /gcloud run services update "\$\{SERVICE\}" \\\n+\s+--region "\$\{REGION\}" --project "\$\{PROJECT_ID\}" --image "\$\{IMAGE\}"/
  );
  assert.match(
    workflow,
    /gcloud run jobs update "\$\{JOB\}" \\\n+\s+--region "\$\{REGION\}" --project "\$\{PROJECT_ID\}" --image "\$\{IMAGE\}"/
  );
  assert.match(workflow, /timeout-minutes: 150/);
  assert.match(workflow, /- name: Promote service and cron with rollback\n\s+timeout-minutes: 10/);
});

test("merge deploys promote signed per-merge images and never migrate", () => {
  assert.match(
    workflow,
    /BUILD_IMAGE: \$\{\{ \(inputs\.release_sha != '' \|\| \(inputs\.image_sha != '' && github\.event_name != 'workflow_dispatch'\)\) && 'true' \|\| 'false' \}\}/
  );
  assert.match(
    workflow,
    /- name: Verify and promote merge image\n\s+if: \$\{\{ inputs\.image_sha != '' && github\.event_name != 'workflow_dispatch' \}\}/
  );
  assert.match(
    workflow,
    /certificate-identity "https:\/\/github\.com\/\$\{\{ github\.repository \}\}\/\.github\/workflows\/release-images\.yml@refs\/heads\/main"/
  );
  assert.doesNotMatch(workflow, /- name: Build and push image/);
  assert.match(
    workflow,
    /- name: Run database migrations\n\s+if: \$\{\{ inputs\.release_sha != '' \}\}/
  );
  assert.match(workflow, /- name: Gate merge deploys on pending migrations/);
  assert.match(
    workflow,
    /git diff --quiet "\$\{last_release\}"\.\.HEAD -- apps\/sdp-api\/src\/db\/migrations/
  );
});

test("merge mode skips the internal smoke gate but requires the caller's", () => {
  assert.match(
    workflow,
    /inputs\.image_sha == ''\n\s+uses: \.\/\.github\/workflows\/sdp-stage-smoke\.yml/
  );
  assert.match(
    workflow,
    /\(inputs\.image_sha != '' && github\.event_name != 'workflow_dispatch' && needs\.smoke\.result == 'skipped'\)/
  );
});

test("rollback verification accepts release-tag and merge-to-main identities", () => {
  assert.match(
    workflow,
    /- name: Verify rollback image signature\n\s+if: \$\{\{ github\.event_name == 'workflow_dispatch' \}\}/
  );
  assert.match(workflow, /refs\/tags\/v\.\+\|refs\/heads\/main/);
});

test("no static Doppler token remains in the deploy pipeline", () => {
  assert.doesNotMatch(workflow, /DOPPLER_TOKEN_CI/);
  assert.match(workflow, /- name: Doppler OIDC login/);
});

test("the orchestrator grants every permission the prod workflow requests", () => {
  const orchestrator = fs.readFileSync(
    path.resolve(here, "../.github/workflows/deploy.yml"),
    "utf8"
  );
  const permissionsBlock = workflow.match(/^permissions:\n((?: {2}[a-z-]+: [a-z-]+\n)+)/m);
  assert.ok(permissionsBlock, "prod workflow must declare a top-level permissions block");
  const requested = permissionsBlock[1]
    .trim()
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  assert.ok(requested.length >= 3, "expected at least contents, id-token, and packages grants");
  const callerJob = orchestrator.match(
    /deploy-api-prod:[\s\S]*?permissions:\n((?: {6}[a-z-]+: [a-z-]+\n)+)/
  )[1];
  for (const grant of requested) {
    assert.ok(
      callerJob.includes(grant),
      `deploy.yml's deploy-api-prod must grant "${grant}" or the run fails at startup`
    );
  }
});

test("candidate verification accepts the signed index digest or its child manifests, nothing else", () => {
  assert.match(workflow, /accepted_digests="\$\{expected_digest\}"/);
  assert.match(workflow, /crane manifest "\$\{IMAGE\}"/);
  assert.match(workflow, /grep -qxF "\$\{revision_digest##\*@\}" <<<"\$\{accepted_digests\}"/);
});

// Execute the actual digest-selection block from the workflow against stubbed
// registries, so CI fails when the shell behavior breaks even if the text
// fragments above still match.
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const blockMatch = workflow.match(
  /(accepted_digests="\$\{expected_digest\}"[\s\S]*?or a manifest of that signed index\." >&2\n\s*exit 1\n\s*fi)/
);
assert.ok(blockMatch, "digest-selection block not found in workflow");
const digestBlock = blockMatch[1];

const INDEX_DIGEST = "sha256:aaaa000000000000000000000000000000000000000000000000000000000000";
const CHILD_DIGEST = "sha256:bbbb000000000000000000000000000000000000000000000000000000000000";
const OTHER_DIGEST = "sha256:cccc000000000000000000000000000000000000000000000000000000000000";
const INDEX_JSON = JSON.stringify({
  mediaType: "application/vnd.oci.image.index.v1+json",
  manifests: [
    { digest: CHILD_DIGEST },
    { digest: "sha256:dddd000000000000000000000000000000000000000000000000000000000000" },
  ],
});
const BARE_JSON = JSON.stringify({ mediaType: "application/vnd.oci.image.manifest.v1+json" });

function runDigestBlock({ craneScript, revisionDigest }) {
  const dir = mkdtempSync(join(tmpdir(), "digest-guard-"));
  const cranePath = join(dir, "crane");
  writeFileSync(cranePath, craneScript);
  chmodSync(cranePath, 0o755);
  const script = [
    "set -euo pipefail",
    `expected_digest="${INDEX_DIGEST}"`,
    `IMAGE="registry.example/repo@${INDEX_DIGEST}"`,
    'candidate_revision="rev-test"',
    `revision_digest="registry.example/repo@${revisionDigest}"`,
    digestBlock,
    "echo GUARD_PASSED",
  ].join("\n");
  try {
    const out = execFileSync("bash", ["-c", script], {
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
      encoding: "utf8",
    });
    return { code: 0, out };
  } catch (err) {
    return { code: err.status, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

const craneOk = `#!/usr/bin/env bash\nprintf '%s' '${INDEX_JSON}'\n`;
const craneBare = `#!/usr/bin/env bash\nprintf '%s' '${BARE_JSON}'\n`;
const craneFail = "#!/usr/bin/env bash\necho 'UNAUTHORIZED' >&2\nexit 1\n";

test("digest guard passes for the signed index's child manifest", () => {
  const r = runDigestBlock({ craneScript: craneOk, revisionDigest: CHILD_DIGEST });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /GUARD_PASSED/);
});

test("digest guard passes for the pinned index digest itself", () => {
  const r = runDigestBlock({ craneScript: craneOk, revisionDigest: INDEX_DIGEST });
  assert.equal(r.code, 0, r.out);
});

test("digest guard rejects a digest outside the signed index", () => {
  const r = runDigestBlock({ craneScript: craneOk, revisionDigest: OTHER_DIGEST });
  assert.equal(r.code, 1);
  assert.match(r.out, /or a manifest of that signed index/);
});

test("digest guard fails loudly, not with a mismatch, when the registry fetch fails", () => {
  const r = runDigestBlock({ craneScript: craneFail, revisionDigest: CHILD_DIGEST });
  assert.equal(r.code, 1);
  assert.match(r.out, /Failed to fetch the pinned manifest/);
  assert.doesNotMatch(r.out, /or a manifest of that signed index/);
});

test("digest guard still accepts an exact match on a bare (non-index) manifest", () => {
  const r = runDigestBlock({ craneScript: craneBare, revisionDigest: INDEX_DIGEST });
  assert.equal(r.code, 0, r.out);
});

test("rollback verification falls back to the signing origin at the same pinned digest", () => {
  assert.match(workflow, /if cosign verify "\$\{IMAGE\}" "\$\{verify_flags\[@\]\}"/);
  assert.match(
    workflow,
    /ORIGIN_IMAGE="ghcr\.io\/\$\{\{ github\.repository_owner \}\}\/sdp\/sdp-api@\$\{IMAGE##\*@\}"/
  );
  assert.match(workflow, /cosign verify "\$\{ORIGIN_IMAGE\}" "\$\{verify_flags\[@\]\}"/);
});
