import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const workflowPath = path.resolve(here, "../.github/workflows/deploy-sdp-api-gcp-prod.yml");
const workflow = fs.readFileSync(workflowPath, "utf8");

test("a canary failure after promotion reports canary-failed, not a deploy failure", () => {
  assert.match(
    workflow,
    /- name: Record canary outcome\n\s+id: canary_outcome\n\s+if: \$\{\{ always\(\) \}\}/
  );
  assert.match(workflow, /canary: \$\{\{ steps\.canary_outcome\.outputs\.result \}\}/);
  assert.match(
    workflow,
    /'cancelled' \|\|\n\s+needs\.deploy\.outputs\.canary == 'failure' && needs\.deploy\.outputs\.tail_clean == 'true' && 'canary-failed'/
  );
  assert.match(workflow, /tail_clean: \$\{\{ steps\.tail_outcome\.outputs\.clean \}\}/);
  assert.match(
    workflow,
    /clean=\$\{\{ \(steps\.rollback_guard\.outcome == 'success' \|\| steps\.rollback_guard\.outcome == 'skipped'\) && \(steps\.remove_tag\.outcome == 'success' \|\| steps\.remove_tag\.outcome == 'skipped'\) \}\}/
  );
});

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

test("release deploys verify and promote the signed image; only merge and approved deploys migrate", () => {
  assert.doesNotMatch(workflow, /run_migrations:/);
  assert.doesNotMatch(workflow, /docker build/);
  assert.match(
    workflow,
    /- name: Verify and promote release image\n\s+if: \$\{\{ inputs\.release_sha != '' \}\}/
  );
  assert.match(
    workflow,
    /- name: Run database migrations\n\s+if: \$\{\{ inputs\.image_sha != '' && \(github\.event_name != 'workflow_dispatch' \|\| inputs\.approved_schema\) \}\}/
  );
  assert.match(workflow, /cosign verify "\$\{SRC_BASE\}@\$\{SRC_DIGEST\}"/);
  assert.match(workflow, /cosign copy --force "\$\{SRC_BASE\}@\$\{SRC_DIGEST\}"/);
  assert.match(workflow, /--certificate-github-workflow-sha "\$\{DEPLOY_IMAGE_SHA\}"/);
  assert.match(workflow, /\$\{DEST_BASE\}:\$\{DEPLOY_IMAGE_SHA\}/);
});

test("manual redeploys verify the promoted image signature before rollout", () => {
  assert.match(
    workflow,
    /- name: Verify rollback image signature\n\s+if: \$\{\{ github\.event_name == 'workflow_dispatch' && !inputs\.approved_schema \}\}/
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
  assert.match(
    workflow,
    /- name: Remove candidate traffic tag\n\s+id: remove_tag\n\s+if: \$\{\{ always\(\) \}\}/
  );
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
    /- name: Roll back incomplete rollout\n\s+id: rollback_guard\n\s+if: \$\{\{ always\(\) \}\}\n\s+timeout-minutes: 5/
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

test("merge deploys promote signed per-merge images and migrate before rollout", () => {
  assert.match(
    workflow,
    /BUILD_IMAGE: \$\{\{ \(inputs\.release_sha != '' \|\| \(inputs\.image_sha != '' && \(github\.event_name != 'workflow_dispatch' \|\| inputs\.approved_schema\)\)\) && 'true' \|\| 'false' \}\}/
  );
  assert.match(
    workflow,
    /- name: Verify and promote merge image\n\s+if: \$\{\{ inputs\.image_sha != '' && \(github\.event_name != 'workflow_dispatch' \|\| inputs\.approved_schema\) \}\}/
  );
  assert.match(
    workflow,
    /- name: Verify rollback image signature\n\s+if: \$\{\{ github\.event_name == 'workflow_dispatch' && !inputs\.approved_schema \}\}/
  );
  assert.match(
    workflow,
    /certificate-identity "https:\/\/github\.com\/\$\{\{ github\.repository \}\}\/\.github\/workflows\/release-images\.yml@refs\/heads\/main"/
  );
  assert.doesNotMatch(workflow, /- name: Build and push image/);
  assert.doesNotMatch(workflow, /prod-merge-gate/);

  const migrate = workflow.indexOf("- name: Run database migrations");
  const execute = workflow.indexOf('gcloud run jobs execute "$' + "{MIGRATE_JOB}", migrate);
  const label = workflow.indexOf(
    '--update-labels "sdp_schema_sha=$' + "{DEPLOY_IMAGE_SHA}",
    execute
  );
  const capture = workflow.indexOf("- name: Capture rollback state", migrate);
  assert.ok(migrate !== -1 && migrate < execute);
  assert.ok(execute < label && label < capture);
});

test("pending migrations are detected before the prod workflow is called", () => {
  const orchestrator = fs.readFileSync(
    path.resolve(here, "../.github/workflows/deploy.yml"),
    "utf8"
  );
  assert.match(
    orchestrator,
    / {2}schema:\n\s+name: Check pending migrations against prod\n\s+needs: changes\n\s+if: needs\.changes\.outputs\.prod == 'true'\n[\s\S]*?environment: production\n/
  );
  assert.match(orchestrator, /--format 'value\(metadata\.labels\.sdp_schema_sha\)'/);
  assert.match(
    orchestrator,
    /git diff --name-only "\$\{applied\}\.\.HEAD" -- apps\/sdp-api\/src\/db\/migrations\/postgres/
  );
  assert.match(orchestrator, /pending="prod schema position unknown/);
  assert.match(
    orchestrator,
    / {2}deploy-api-prod:\n[\s\S]*?needs: \[changes, deploy-api-stage, schema\]\n\s+if: >-\n\s+needs\.changes\.outputs\.prod == 'true' &&\n\s+needs\.schema\.outputs\.pending == 'false' &&/
  );

  assert.doesNotMatch(workflow, /\n {2}schema:\n/);
  assert.doesNotMatch(workflow, /pending_migrations/);
  assert.match(workflow, /name: Deploy production image\n\s+needs: smoke\n/);
  assert.match(workflow, /\n\s+environment: production\n/);
  assert.doesNotMatch(workflow, /environment: \$\{\{/);
  assert.match(
    workflow,
    /ref: \$\{\{ inputs\.release_sha != '' && inputs\.release_sha \|\| \(inputs\.approved_schema && inputs\.image_sha\) \|\| github\.sha \}\}/
  );
});

test("every migrating deploy is ordered against the schema prod last applied", () => {
  assert.match(
    workflow,
    /- name: Read the schema position prod last applied\n\s+run: \|\n[\s\S]*?APPLIED_SCHEMA_SHA=\$\{applied\}/
  );
  assert.match(
    workflow,
    /- name: Refuse a deploy that is behind prod\n\s+if: \$\{\{ env\.BUILD_IMAGE == 'true' \}\}/
  );
  assert.match(workflow, /git merge-base --is-ancestor "\$\{DEPLOY_IMAGE_SHA\}" origin\/main/);
  assert.match(
    workflow,
    /floor="\$\{APPLIED_SCHEMA_SHA:-\$\(git describe --tags --abbrev=0 --match 'v\*' origin\/main\)\}"\n\s+if ! git merge-base --is-ancestor "\$\{floor\}" "\$\{DEPLOY_IMAGE_SHA\}"/
  );
  assert.match(
    workflow,
    /- name: Refuse a non-migrating deploy that carries unapplied migrations\n\s+if: \$\{\{ inputs\.release_sha != '' \|\| \(github\.event_name == 'workflow_dispatch' && !inputs\.approved_schema\) \}\}/
  );
  assert.match(
    workflow,
    /if git merge-base --is-ancestor "\$\{DEPLOY_IMAGE_SHA\}" "\$\{APPLIED_SCHEMA_SHA\}"; then\n\s+exit 0\n\s+fi\n\s+pending="\$\(git diff --name-only "\$\{APPLIED_SCHEMA_SHA\}" "\$\{DEPLOY_IMAGE_SHA\}" -- apps\/sdp-api\/src\/db\/migrations\/postgres\)"/
  );
  assert.match(
    workflow,
    /if \[\[ -n "\$\{RELEASE_SHA\}" \]\]; then\n\s+echo "Prod schema position is unknown/
  );
  const read = workflow.indexOf("- name: Read the schema position prod last applied");
  const refuse = workflow.indexOf("- name: Refuse a deploy that is behind prod");
  const promoteRelease = workflow.indexOf("- name: Verify and promote release image");
  assert.ok(read !== -1 && read < refuse && refuse < promoteRelease);
});

test("the approval workflow waits outside the deploy concurrency groups", () => {
  const approval = fs.readFileSync(
    path.resolve(here, "../.github/workflows/apply-prod-migrations.yml"),
    "utf8"
  );
  assert.doesNotMatch(approval, /^concurrency:/m);
  assert.match(
    approval,
    /^run-name: "Apply pending migrations to prod — \$\{\{ inputs\.image_sha \}\}"$/m
  );
  assert.match(
    approval,
    / {2}pending:\n\s+name: List pending migrations\n\s+if: >-\n[\s\S]*?vars\.CONTINUOUS_PROD_DEPLOY == 'true'\n[\s\S]*?environment: production\n/
  );
  assert.match(approval, /git merge-base --is-ancestor "\$\{IMAGE_SHA\}" origin\/main/);
  assert.match(approval, /git merge-base --is-ancestor "\$\{applied\}" "\$\{IMAGE_SHA\}"/);
  const onMain = approval.indexOf("- name: Require a commit on main");
  const stageGreen = approval.indexOf("- name: Require a green stage deploy for the commit");
  const gcpAuth = approval.indexOf("- name: Authenticate to GCP");
  assert.ok(onMain !== -1 && onMain < stageGreen && stageGreen < gcpAuth);
  assert.match(
    approval,
    /actions\/workflows\/deploy\.yml\/runs\?head_sha=\$\{IMAGE_SHA\}&event=push/
  );
  assert.match(
    approval,
    /select\(\.name \| startswith\("sdp-api \+ worker \+ cron — stage \+ smoke"\)\)\] \| length > 0 and all\(\.conclusion == "success"\)/
  );
  assert.match(approval, /^permissions:\n\s+actions: read\n/m);
  assert.match(
    approval,
    / {2}approve:\n\s+name: Schema approval\n\s+needs: pending\n\s+if: vars\.CONTINUOUS_PROD_DEPLOY == 'true'\n/
  );

  assert.match(
    workflow,
    /- name: Refuse an approved deploy that was re-run or self-approved\n\s+if: \$\{\{ inputs\.approved_schema \}\}/
  );
  assert.match(workflow, /if \[\[ "\$\{RUN_ATTEMPT\}" != "1" \]\]; then/);
  assert.match(workflow, /actions\/runs\/\$\{RUN_ID\}\/approvals/);
  assert.match(workflow, /\[\.author\.login \/\/ "unlinked", \.committer\.login \/\/ "unlinked"\]/);
  assert.match(workflow, /if grep -qx 'unlinked' <<<"\$\{authors\}"; then/);
  assert.match(
    workflow,
    /git log --format=%H "\$\{since\}\.\.\$\{DEPLOY_IMAGE_SHA\}" -- apps\/sdp-api\/src\/db\/migrations\/postgres/
  );
  assert.match(
    workflow,
    /\(!inputs\.approved_schema \|\| vars\.CONTINUOUS_PROD_DEPLOY == 'true'\) &&/
  );
  const selfApproval = workflow.indexOf(
    "- name: Refuse an approved deploy that was re-run or self-approved"
  );
  const behind = workflow.indexOf("- name: Refuse a deploy that is behind prod");
  assert.ok(selfApproval !== -1 && selfApproval < behind);
  assert.match(
    approval,
    /git diff --name-only "\$\{applied\}\.\.\$\{IMAGE_SHA\}" -- apps\/sdp-api\/src\/db\/migrations\/postgres/
  );
  assert.match(
    approval,
    / {2}approve:\n\s+name: Schema approval\n\s+needs: pending\n[\s\S]*?environment: release-production\n\s+concurrency:\n\s+group: sdp-prod-schema-approval\n\s+cancel-in-progress: true/
  );
  assert.match(
    approval,
    / {2}deploy:\n[\s\S]*?needs: approve\n[\s\S]*?uses: \.\/\.github\/workflows\/deploy-sdp-api-gcp-prod\.yml\n\s+with:\n\s+image_sha: \$\{\{ inputs\.image_sha \}\}\n\s+approved_schema: true/
  );
  assert.match(approval, /env:\n\s+IMAGE_SHA: \$\{\{ inputs\.image_sha \}\}/);
  assert.doesNotMatch(approval, /run: [^\n]*\$\{\{ inputs\./);
  assert.match(approval, /\[\[ ! "\$\{IMAGE_SHA\}" =~ \^\[0-9a-f\]\{40\}\$ \]\]/);
  const pending = approval.indexOf("  pending:");
  const approve = approval.indexOf("  approve:");
  const deploy = approval.indexOf("  deploy:");
  assert.ok(pending !== -1 && pending < approve && approve < deploy);
});

test("the orchestrator sends every continuous merge to prod", () => {
  const orchestrator = fs.readFileSync(
    path.resolve(here, "../.github/workflows/deploy.yml"),
    "utf8"
  );
  const changes = orchestrator.slice(
    orchestrator.indexOf("  changes:"),
    orchestrator.indexOf("  notify-start:")
  );
  assert.match(changes, /prod: \$\{\{ steps\.detect\.outputs\.prod \}\}/);
  assert.match(changes, /CONTINUOUS_PROD_DEPLOY: \$\{\{ vars\.CONTINUOUS_PROD_DEPLOY \}\}/);
  assert.doesNotMatch(orchestrator, /prod_hold|prod-merge-gate/);

  const prodJob = orchestrator.slice(orchestrator.indexOf("  deploy-api-prod:"));
  assert.match(prodJob, /if: >-\n\s+needs\.changes\.outputs\.prod == 'true' &&/);
  assert.match(prodJob, /vars\.CONTINUOUS_PROD_DEPLOY == 'true'/);
  assert.match(
    prodJob,
    / {2}request-schema-approval:\n[\s\S]*?needs: \[deploy-api-stage, schema\]\n\s+if: needs\.schema\.outputs\.pending == 'true' && needs\.deploy-api-stage\.result == 'success'\n[\s\S]*?permissions:\n\s+actions: write/
  );
  assert.match(
    prodJob,
    /gh workflow run apply-prod-migrations\.yml --repo "\$\{\{ github\.repository \}\}" --ref main -f image_sha="\$\{\{ github\.sha \}\}"/
  );
  assert.match(
    orchestrator,
    /notify-end:\n\s+needs: \[changes, deploy-api-stage, schema, deploy-api-prod, request-schema-approval\]/
  );
  assert.match(
    orchestrator,
    /needs\.request-schema-approval\.result == 'success' && 'stage \(prod held: pending migrations, approval run dispatched\)' \|\|\n\s+needs\.schema\.outputs\.pending == 'true' && 'stage \(prod held: pending migrations, approval not dispatched\)'/
  );
  assert.match(
    orchestrator,
    /needs\.schema\.result == 'failure' \|\| needs\.deploy-api-prod\.result == 'failure' \|\| needs\.request-schema-approval\.result == 'failure'\) && 'FAILED'/
  );
  assert.match(
    orchestrator,
    /needs\.schema\.result == 'cancelled' \|\| needs\.deploy-api-prod\.result == 'cancelled' \|\| needs\.request-schema-approval\.result == 'cancelled'\) && 'CANCELLED'/
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
    /- name: Verify rollback image signature\n\s+if: \$\{\{ github\.event_name == 'workflow_dispatch' && !inputs\.approved_schema \}\}/
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
