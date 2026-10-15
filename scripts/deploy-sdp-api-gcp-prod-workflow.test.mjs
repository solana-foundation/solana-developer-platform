import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const workflowPath = path.resolve(here, "../.github/workflows/deploy-sdp-api-gcp-prod.yml");
const workflow = fs.readFileSync(workflowPath, "utf8");

test("a held or restored deploy says so in Slack for approval, manual and merge deploys", () => {
  assert.match(workflow, /rolled_back: \$\{\{ steps\.settle\.outputs\.rolled_back \}\}/);
  assert.match(workflow, /canary_failed: \$\{\{ steps\.settle\.outputs\.canary_failed \}\}/);
  assert.match(
    workflow,
    /workflow_call:[\s\S]*?outputs:\n\s+rolled_back:\n\s+description: "[^"\n]+"\n\s+value: \$\{\{ jobs\.finish\.outputs\.rolled_back \}\}\n\s+canary_failed:\n\s+description: "[^"\n]+"\n\s+value: \$\{\{ jobs\.finish\.outputs\.canary_failed \}\}\n\s+workflow_dispatch:/
  );
  assert.match(
    workflow,
    /'web-held' \|\|\n\s+needs\.finish\.outputs\.canary_failed == 'true' && 'canary-failed' \|\|\n\s+needs\.finish\.outputs\.rolled_back == 'true' && 'rolled-back' \|\|\n\s+needs\.deploy\.result == 'cancelled' && 'cancelled' \|\|\n\s+'failure' \}\}/
  );
  assert.doesNotMatch(workflow, /tail_clean|canary_outcome/);
  const notifier = fs.readFileSync(path.resolve(here, "notify-slack.sh"), "utf8");
  assert.match(
    notifier,
    /\n {2}canary-failed\) MARKER="\[CANARY FAILED, PROD HELD\] Deploy \$LABEL"/
  );
  assert.match(notifier, /\n {2}rolled-back\) MARKER="\[ROLLED BACK, PROD HELD\] Deploy \$LABEL"/);

  const orchestrator = fs.readFileSync(
    path.resolve(here, "../.github/workflows/deploy.yml"),
    "utf8"
  );
  assert.match(
    orchestrator,
    /OUTCOME: >-\n\s+\$\{\{ needs\.deploy-api-prod\.outputs\.canary_failed == 'true' && 'CANARY FAILED, PROD HELD' \|\|\n\s+needs\.deploy-api-prod\.outputs\.rolled_back == 'true' && 'ROLLED BACK, PROD HELD' \|\|\n/
  );
  assert.match(orchestrator, /\n\s+FAILED\|"CANARY FAILED, PROD HELD"\) COLOR="#cc0000" ;;\n/);
});

test("promotion and the canary are separate outcomes, and the canary gets three runs", () => {
  const promote = workflow.indexOf("- name: Promote service and cron with rollback");
  const canary = workflow.indexOf("- name: Run prod canary against the promoted revision");
  assert.match(
    workflow,
    /\n {6}rollout_complete: \$\{\{ steps\.promote\.outcome == 'success' \}\}\n/
  );
  assert.match(workflow, /\n {6}canary_passed: \$\{\{ steps\.canary\.outcome == 'success' \}\}\n/);
  assert.match(
    workflow,
    /- name: Run prod canary against the promoted revision\n\s+id: canary\n\s+if: \$\{\{ steps\.promote\.outcome == 'success' \}\}\n\s+timeout-minutes: 12\n/
  );
  assert.match(
    workflow,
    /- name: Record managed monitor migration gate\n\s+if: \$\{\{ steps\.canary\.outcome == 'success' \}\}\n/
  );
  const monitorNote = workflow.indexOf("- name: Record managed monitor migration gate");
  const finishJob = workflow.indexOf("\n  finish:\n");
  assert.ok(promote < canary && canary < monitorNote && monitorNote < finishJob);

  const counter = join(mkdtempSync(join(tmpdir(), "canary-runs-")), "runs");
  const flaky = `n=$(( $(cat '${counter}' 2>/dev/null || echo 0) + 1 )); echo "$n" > '${counter}'; [ "$n" -ge 3 ]`;
  const recovered = runStep("Run prod canary against the promoted revision", {
    env: deployEnv,
    stubs: { gcloud: flaky },
  });
  assert.equal(recovered.code, 0, recovered.out);
  assert.equal(recovered.calls.length, 3);
  assert.equal(recovered.calls[0], `gcloud run jobs execute sdp-prod-canary ${scope} --wait`);

  const failing = runStep("Run prod canary against the promoted revision", {
    env: deployEnv,
    stubs: { gcloud: "exit 1" },
  });
  assert.equal(failing.code, 1);
  assert.equal(failing.calls.length, 3);
  assert.match(failing.out, /::error::The canary failed 3 runs in a row/);
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

test("automatic production deploys are called from main with a required image SHA", () => {
  assert.match(
    workflow,
    /workflow_call:\n\s+inputs:\n\s+image_sha:\n\s+description: "[^"\n]*"\n\s+type: string\n\s+required: true\n\s+approved_schema:/
  );
  assert.doesNotMatch(workflow, /\n\s+release:\n/);
  assert.match(
    workflow,
    /name: Deploy production image\n\s+if: >-\n\s+github\.repository == 'solana-foundation\/solana-developer-platform' &&\n\s+github\.ref == 'refs\/heads\/main' &&\n\s+\(!inputs\.approved_schema \|\| vars\.CONTINUOUS_PROD_DEPLOY == 'true'\)\n\s+runs-on:/
  );
});

test("deploys promote the signed image without rebuilding; only merge and approved deploys migrate", () => {
  assert.doesNotMatch(workflow, /run_migrations:/);
  assert.doesNotMatch(workflow, /docker build/);
  assert.match(
    workflow,
    /- name: Run database migrations\n\s+if: \$\{\{ env\.BUILD_IMAGE == 'true' \}\}/
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
  assert.match(workflow, /echo "tag=\$\{candidate_tag\}" >> "\$\{GITHUB_OUTPUT\}"/);
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
  assert.match(
    workflow,
    /--format='value\(spec\.template\.spec\.template\.spec\.containers\[0\]\.image\)'/
  );
  for (const [output, step, key] of [
    ["previous_traffic", "capture", "traffic"],
    ["previous_cron_image", "capture", "cron_image"],
    ["previous_worker_image", "capture", "worker_image"],
    ["candidate_tag", "candidate", "tag"],
    ["breaking_migrations", "breaking", "migrations"],
  ]) {
    assert.match(
      workflow,
      new RegExp(`\\n {6}${output}: \\$\\{\\{ steps\\.${step}\\.outputs\\.${key} \\}\\}\\n`)
    );
    const env = output.toUpperCase();
    assert.match(
      workflow,
      new RegExp(`\\n {6}${env}: \\$\\{\\{ needs\\.deploy\\.outputs\\.${output} \\}\\}\\n`)
    );
  }
  assert.match(
    workflow,
    /\n {6}rollout_started: \$\{\{ steps\.candidate\.outcome == 'success' \|\| steps\.candidate\.outcome == 'failure' \|\| steps\.candidate\.outcome == 'cancelled' \}\}\n/
  );
  assert.match(
    workflow,
    /- name: Restore an incomplete rollout or hold prod\n\s+id: settle\n\s+if: \$\{\{ always\(\) \}\}\n\s+timeout-minutes: 5/
  );
  assert.match(workflow, /--to-revisions "\$\{CANDIDATE_REVISION\}=100"/);
  assert.match(workflow, /--to-revisions "\$\{PREVIOUS_TRAFFIC\}"/);
  assert.match(workflow, /--image "\$\{PREVIOUS_CRON_IMAGE\}"/);

  const candidateStep = workflow.indexOf("- name: Deploy candidate without production traffic");
  const candidateDeploy = workflow.indexOf("gcloud run services update", candidateStep);
  const promotionStep = workflow.indexOf("- name: Promote service and cron with rollback");
  const promotion = workflow.indexOf("--to-revisions", promotionStep);
  const canonicalReadiness = workflow.indexOf('"https://api.solana.com/health/ready"', promotion);
  const cronUpdate = workflow.indexOf("gcloud run jobs update", canonicalReadiness);
  const canary = workflow.indexOf(
    "- name: Run prod canary against the promoted revision",
    cronUpdate
  );
  const rollback = workflow.indexOf("- name: Restore an incomplete rollout or hold prod", canary);
  assert.ok(candidateStep !== -1 && candidateStep < candidateDeploy);
  assert.ok(candidateDeploy < promotion && promotion < canonicalReadiness);
  assert.ok(canonicalReadiness < cronUpdate && cronUpdate < canary && canary < rollback);
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
  assert.match(
    workflow,
    /- name: Promote service and cron with rollback\n\s+id: promote\n\s+timeout-minutes: 10/
  );
});

test("merge deploys promote signed per-merge images and migrate before rollout", () => {
  assert.match(
    workflow,
    /BUILD_IMAGE: \$\{\{ \(github\.event_name != 'workflow_dispatch' \|\| inputs\.approved_schema\) && 'true' \|\| 'false' \}\}/
  );
  assert.match(
    workflow,
    /- name: Verify and promote merge image\n\s+if: \$\{\{ env\.BUILD_IMAGE == 'true' \}\}/
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
    / {2}deploy-api-prod:\n[\s\S]*?needs: \[changes, deploy-api-stage, schema\]\n(?:\s+#[^\n]*\n)*\s+if: >-\n\s+always\(\) &&\n\s+needs\.changes\.result == 'success' &&\n\s+needs\.deploy-api-stage\.result == 'success' &&\n\s+needs\.schema\.result == 'success' &&\n\s+needs\.changes\.outputs\.prod == 'true' &&\n\s+needs\.schema\.outputs\.pending == 'false' &&/
  );

  assert.doesNotMatch(workflow, /\n {2}schema:\n/);
  assert.doesNotMatch(workflow, /pending_migrations/);
  assert.match(workflow, /\n\s+environment: production\n/);
  assert.doesNotMatch(workflow, /environment: \$\{\{/);
  assert.match(
    workflow,
    /ref: \$\{\{ \(inputs\.approved_schema && inputs\.image_sha\) \|\| github\.sha \}\}/
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
    /- name: Refuse a non-migrating deploy that carries unapplied migrations\n\s+if: \$\{\{ github\.event_name == 'workflow_dispatch' && !inputs\.approved_schema \}\}\n\s+run: \|\n\s+set -euo pipefail\n\s+if \[\[ -z "\$\{APPLIED_SCHEMA_SHA\}" \]\]; then\n\s+exit 0\n\s+fi\n\s+if git merge-base --is-ancestor "\$\{DEPLOY_IMAGE_SHA\}" "\$\{APPLIED_SCHEMA_SHA\}"; then\n\s+exit 0\n\s+fi\n\s+pending="\$\(git diff --name-only "\$\{APPLIED_SCHEMA_SHA\}" "\$\{DEPLOY_IMAGE_SHA\}" -- apps\/sdp-api\/src\/db\/migrations\/postgres\)"/
  );
  const read = workflow.indexOf("- name: Read the schema position prod last applied");
  const refuse = workflow.indexOf("- name: Refuse a deploy that is behind prod");
  const refuseUnapplied = workflow.indexOf(
    "- name: Refuse a non-migrating deploy that carries unapplied migrations"
  );
  const promoteMerge = workflow.indexOf("- name: Verify and promote merge image");
  assert.ok(read !== -1 && read < refuse && refuse < refuseUnapplied);
  assert.ok(refuseUnapplied < promoteMerge);
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
    /\(!inputs\.approved_schema \|\| vars\.CONTINUOUS_PROD_DEPLOY == 'true'\)\n/
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
  assert.match(
    prodJob,
    /if: >-\n\s+always\(\) &&\n[\s\S]*?needs\.changes\.outputs\.prod == 'true' &&/
  );
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
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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

// Run one step's shell exactly as the workflow has it, with stubbed commands
// first on PATH and the GitHub step files in a temp dir.
function stepScript(name, source = workflow) {
  const header = `      - name: ${name}\n`;
  const start = source.indexOf(header);
  assert.notEqual(start, -1, `missing step: ${name}`);
  const lines = source.slice(start + header.length).split("\n");
  const run = lines.findIndex((line) => line === "        run: |" || line.startsWith("      - "));
  assert.equal(lines[run], "        run: |", `step has no run block: ${name}`);
  const body = [];
  for (const line of lines.slice(run + 1)) {
    if (line !== "" && !line.startsWith(" ".repeat(10))) break;
    body.push(line.slice(10));
  }
  return body.join("\n");
}

const gitEnv = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };

function runStep(name, { env = {}, stubs = {}, cwd, source = workflow } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "prod-deploy-step-"));
  const calls = join(dir, "calls.log");
  const files = {
    GITHUB_ENV: join(dir, "github-env"),
    GITHUB_OUTPUT: join(dir, "github-output"),
    GITHUB_STEP_SUMMARY: join(dir, "github-summary"),
  };
  for (const file of [calls, ...Object.values(files)]) writeFileSync(file, "");
  for (const [command, body] of Object.entries({ sleep: "exit 0", ...stubs })) {
    const stub = join(dir, command);
    writeFileSync(
      stub,
      `#!/usr/bin/env bash\nprintf '%s\\n' "${command} $*" >> '${calls}'\n${body}\n`
    );
    chmodSync(stub, 0o755);
  }
  const result = spawnSync("bash", ["-e", "-c", stepScript(name, source)], {
    cwd,
    env: { PATH: `${dir}:${process.env.PATH}`, ...gitEnv, ...files, ...env },
    encoding: "utf8",
    // A socket on stdin makes bash source ~/.bashrc, which may reorder PATH.
    stdio: ["ignore", "pipe", "pipe"],
  });
  const read = (file) => readFileSync(file, "utf8");
  return {
    code: result.status,
    out: `${result.stdout}${result.stderr}`,
    calls: read(calls)
      .split("\n")
      .filter((call) => call !== "" && !call.startsWith("sleep ")),
    env: read(files.GITHUB_ENV),
    output: read(files.GITHUB_OUTPUT),
    summary: read(files.GITHUB_STEP_SUMMARY),
  };
}

const deployEnv = {
  PROJECT_ID: "solana-developer-platform",
  REGION: "us-central1",
  SERVICE: "sdp-prod-api-public",
  JOB: "sdp-prod-api-public-cron",
  WORKER_SERVICE: "sdp-prod-worker",
  MIGRATE_JOB: "sdp-prod-api-public-migrate",
};
const deploySha = "d".repeat(40);
const migrations = "apps/sdp-api/src/db/migrations/postgres";
const rollbackEnv = {
  ...deployEnv,
  DEPLOY_IMAGE_SHA: deploySha,
  ROLLOUT_STARTED: "true",
  PREVIOUS_TRAFFIC: "sdp-prod-api-public-00041-old=100",
  PREVIOUS_CRON_IMAGE: "registry.example/cron@sha256:old",
  PREVIOUS_WORKER_IMAGE: "registry.example/worker@sha256:old",
};
const scope = "--region us-central1 --project solana-developer-platform";

const settleStep = "Restore an incomplete rollout or hold prod";
const holdCall = `gcloud run jobs update sdp-prod-api-public-migrate ${scope} --update-labels sdp_prod_hold=${deploySha}`;

test("a failed canary holds prod on the new revision and leaves the rollback to a person", () => {
  for (const [breaking, next] of [
    ["", /run "Roll back sdp-api prod to the previous build" or fix forward/],
    [
      `${migrations}/0133_drop.sql`,
      /fix forward, since the previous build cannot run on the schema/,
    ],
  ]) {
    const settle = runStep(settleStep, {
      env: {
        ...rollbackEnv,
        ROLLOUT_COMPLETE: "true",
        CANARY_PASSED: "false",
        BREAKING_MIGRATIONS: breaking,
      },
      stubs: { gcloud: "exit 0" },
    });
    assert.equal(settle.code, 0, settle.out);
    assert.deepEqual(settle.calls, [holdCall]);
    assert.equal(settle.output, "canary_failed=true\n");
    assert.match(
      settle.out,
      new RegExp(`::error::The canary failed on ${deploySha}\\. Prod stays on it and is held`)
    );
    assert.match(settle.out, next);
  }

  const unheld = runStep(settleStep, {
    env: { ...rollbackEnv, ROLLOUT_COMPLETE: "true", CANARY_PASSED: "false" },
    stubs: { gcloud: "exit 1" },
  });
  assert.equal(unheld.code, 1);
  assert.match(unheld.out, /sdp_prod_hold could not be set\. Pause merges by hand/);
  assert.equal(unheld.output, "");
});

test("a rollout that fails before its canary is restored, as on main, and held", () => {
  const settle = runStep(settleStep, {
    env: { ...rollbackEnv, ROLLOUT_COMPLETE: "false", CANARY_PASSED: "false" },
    stubs: { gcloud: "exit 0" },
  });
  assert.equal(settle.code, 0, settle.out);
  assert.deepEqual(settle.calls, [
    `gcloud run services update-traffic sdp-prod-api-public ${scope} --to-revisions sdp-prod-api-public-00041-old=100`,
    holdCall,
    `gcloud run jobs update sdp-prod-api-public-cron ${scope} --image registry.example/cron@sha256:old`,
    `gcloud run services update sdp-prod-worker ${scope} --image registry.example/worker@sha256:old`,
    `gcloud run jobs update sdp-prod-api-public-migrate ${scope} --remove-labels sdp_prod_previous_revision`,
  ]);
  assert.equal(settle.output, "rolled_back=true\n");
  assert.match(settle.summary, new RegExp(`set sdp_prod_hold=${deploySha}`));
});

test("a passed canary or an unstarted rollout leaves prod alone", () => {
  for (const env of [
    { ...rollbackEnv, ROLLOUT_COMPLETE: "true", CANARY_PASSED: "true" },
    { ...rollbackEnv, ROLLOUT_STARTED: "" },
  ]) {
    const settle = runStep(settleStep, { env, stubs: { gcloud: "exit 0" } });
    assert.equal(settle.code, 0, settle.out);
    assert.deepEqual(settle.calls, []);
    assert.equal(settle.output, "");
  }
});

test("a run that applied a breaking migration is held but never restored", () => {
  const settle = runStep(settleStep, {
    env: {
      ...rollbackEnv,
      ROLLOUT_COMPLETE: "false",
      BREAKING_MIGRATIONS: `${migrations}/0133_drop.sql`,
    },
    stubs: { gcloud: "exit 0" },
  });
  assert.equal(settle.code, 1);
  assert.deepEqual(settle.calls, [holdCall]);
  assert.match(
    settle.out,
    /::error::This run applied breaking migrations \(apps\/sdp-api\/src\/db\/migrations\/postgres\/0133_drop\.sql\)/
  );
  assert.equal(settle.output, "");
});

test("a failed restore still sets the hold and fails the run without reporting a restore", () => {
  const settle = runStep(settleStep, {
    env: { ...rollbackEnv, ROLLOUT_COMPLETE: "false" },
    stubs: { gcloud: 'case "$*" in *update-traffic*) exit 1 ;; esac' },
  });
  assert.equal(settle.code, 1);
  assert.equal(settle.calls.length, 4);
  assert.equal(settle.calls[1], holdCall);
  assert.ok(!settle.calls.some((call) => call.includes("--remove-labels")));
  assert.match(settle.out, /Automatic restore was incomplete; escalate immediately\./);
  assert.equal(settle.output, "");
});

test("merge and approval deploys refuse while prod is held; a manual dispatch can lift it", () => {
  const holdStep = "Refuse a merge or approval deploy while prod is held";
  assert.match(
    workflow,
    /- name: Refuse a merge or approval deploy while prod is held\n\s+if: \$\{\{ env\.BUILD_IMAGE == 'true' && !inputs\.clear_hold \}\}\n/
  );
  const holdCheck = workflow.indexOf(`- name: ${holdStep}`);
  assert.ok(workflow.indexOf("- name: Read the schema position prod last applied") < holdCheck);
  assert.ok(holdCheck < workflow.indexOf("- name: Verify and promote merge image"));
  assert.ok(holdCheck < workflow.indexOf("- name: Run database migrations"));

  const held = runStep(holdStep, {
    env: deployEnv,
    stubs: { gcloud: `printf '%s' '${deploySha}'` },
  });
  assert.equal(held.code, 1);
  assert.match(held.out, new RegExp(`Prod is held \\(sdp_prod_hold=${deploySha}\\)\\.`));
  assert.deepEqual(held.calls, [
    `gcloud run jobs describe sdp-prod-api-public-migrate ${scope} --format value(metadata.labels.sdp_prod_hold)`,
  ]);
  assert.equal(runStep(holdStep, { env: deployEnv, stubs: { gcloud: "exit 0" } }).code, 0);
  assert.notEqual(runStep(holdStep, { env: deployEnv, stubs: { gcloud: "exit 1" } }).code, 0);

  const clearHoldInput =
    /\n {6}clear_hold:\n\s+description: "[^"\n]+"\n\s+type: boolean\n\s+required: false\n\s+default: false\n/g;
  assert.equal(workflow.match(clearHoldInput).length, 2, "workflow_call and workflow_dispatch");
  const orchestrator = fs.readFileSync(
    path.resolve(here, "../.github/workflows/deploy.yml"),
    "utf8"
  );
  assert.doesNotMatch(orchestrator, /clear_hold/);
  assert.match(
    workflow,
    /- name: Lift the prod hold\n\s+if: \$\{\{ steps\.canary\.outcome == 'success' && inputs\.clear_hold \}\}\n/
  );
  assert.ok(
    workflow.indexOf("- name: Run prod canary against the promoted revision") <
      workflow.indexOf("- name: Lift the prod hold")
  );
  const lift = runStep("Lift the prod hold", { env: deployEnv, stubs: { gcloud: "exit 0" } });
  assert.equal(lift.code, 0, lift.out);
  assert.deepEqual(lift.calls, [
    `gcloud run jobs update sdp-prod-api-public-migrate ${scope} --remove-labels sdp_prod_hold`,
  ]);
});

test("a manual dispatch holds prod before it changes anything, unless it lifts the hold", () => {
  const manualHold = "Hold prod for a manual deploy";
  assert.match(
    workflow,
    /- name: Hold prod for a manual deploy\n\s+if: \$\{\{ env\.BUILD_IMAGE != 'true' && !inputs\.clear_hold \}\}\n/
  );
  const capture = workflow.indexOf("- name: Capture rollback state");
  const hold = workflow.indexOf(`- name: ${manualHold}`);
  const candidate = workflow.indexOf("- name: Deploy candidate without production traffic");
  assert.ok(workflow.indexOf("- name: Verify rollback image signature") < capture);
  assert.ok(capture < hold && hold < candidate);

  const env = { ...deployEnv, DEPLOY_IMAGE_SHA: deploySha };
  const run = runStep(manualHold, { env, stubs: { gcloud: "exit 0" } });
  assert.equal(run.code, 0, run.out);
  assert.deepEqual(run.calls, [
    `gcloud run jobs update sdp-prod-api-public-migrate ${scope} --update-labels sdp_prod_hold=${deploySha}`,
  ]);
  const failed = runStep(manualHold, { env, stubs: { gcloud: "exit 1" } });
  assert.notEqual(failed.code, 0);
  assert.equal(failed.calls.length, 1);
});

const gateStep = "Refuse a breaking migration until prod serves its parent";

test("breaking migrations are ordered before any image or schema change", () => {
  assert.match(
    workflow,
    /- name: Refuse a breaking migration until prod serves its parent\n\s+id: breaking\n\s+if: \$\{\{ env\.BUILD_IMAGE == 'true' \}\}\n/
  );
  const gate = workflow.indexOf(`- name: ${gateStep}`);
  assert.ok(workflow.indexOf("- name: Refuse a deploy that is behind prod") < gate);
  assert.ok(gate < workflow.indexOf("- name: Verify and promote merge image"));
  assert.ok(gate < workflow.indexOf("- name: Run database migrations"));
});

test("the gate reads the breaking directive exactly as the migration lint does", () => {
  const lint = fs.readFileSync(path.resolve(here, "check-migration-compat.mjs"), "utf8");
  const literal = lint.match(/const BREAKING_DIRECTIVE = \/(.+)\/([a-z]*);/);
  assert.ok(literal, "BREAKING_DIRECTIVE not found in the migration lint");
  const lintDirective = new RegExp(literal[1], literal[2]);
  const pattern = stepScript(gateStep).match(/grep -Eq '([^']+)'/)[1];
  for (const line of [
    "-- sdp:migration-compat: breaking",
    "--sdp:migration-compat:breaking",
    "--   sdp:migration-compat:   breaking   ",
    "-- sdp:migration-compat: breaking\r",
    "  -- sdp:migration-compat: breaking",
    "-- sdp:migration-compat: breaking change",
    "-- sdp:migration-compat: non-breaking",
    "SELECT 1; -- sdp:migration-compat: breaking",
    "-- SDP:migration-compat: breaking",
  ]) {
    const sql = `SELECT 1;\n${line}\nDROP TABLE legacy;\n`;
    const grep = spawnSync("grep", ["-Eq", pattern], { input: sql });
    assert.equal(grep.status === 0, lintDirective.test(sql), JSON.stringify(line));
  }
});

function git(cwd, ...args) {
  return execFileSync(
    "git",
    [
      "-c",
      "user.name=test",
      "-c",
      "user.email=test@example.com",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "init.defaultBranch=main",
      ...args,
    ],
    { cwd, encoding: "utf8", env: { ...process.env, ...gitEnv } }
  ).trim();
}

function scratchRepo(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  git(dir, "init", "-q");
  const commit = (message, files) => {
    for (const [file, content] of Object.entries(files)) {
      mkdirSync(path.dirname(join(dir, file)), { recursive: true });
      writeFileSync(join(dir, file), content);
    }
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", message);
    return git(dir, "rev-parse", "HEAD");
  };
  return { dir, commit };
}

// base (v0.1.0) reads `legacy`; stopReading drops the read; drop is the
// migrations-only contraction; head is a later, unrelated merge.
function migrationRepo() {
  const { dir, commit } = scratchRepo("breaking-gate-");
  const base = commit("base", {
    "app.txt": "reads legacy\n",
    [`${migrations}/0001_init.sql`]: "CREATE TABLE legacy (id int);\n",
  });
  git(dir, "tag", "v0.1.0");
  const stopReading = commit("stop reading legacy", { "app.txt": "reads nothing\n" });
  const drop = commit("drop legacy", {
    [`${migrations}/0002_drop_legacy.sql`]:
      "-- sdp:migration-compat: breaking\nDROP TABLE legacy;\n",
  });
  const head = commit("unrelated", { "app.txt": "reads nothing, faster\n" });
  git(dir, "update-ref", "refs/remotes/origin/main", head);
  return { dir, base, stopReading, drop, head };
}

const servingRevision = "sdp-prod-api-public-00041-old";
const serviceJson = (traffic) => JSON.stringify({ status: { traffic } });
const health = (commit, revision = servingRevision) =>
  JSON.stringify({ status: "ready", revision, commit });

function runGate(repo, { applied, serving, healthJson, traffic }) {
  return runStep(gateStep, {
    cwd: repo.dir,
    env: {
      ...deployEnv,
      DEPLOY_IMAGE_SHA: repo.head,
      APPLIED_SCHEMA_SHA: applied,
      SERVICE_JSON: serviceJson(
        traffic ?? [
          { revisionName: servingRevision, percent: 100 },
          { revisionName: "sdp-prod-api-public-00040-tagged", tag: "candidate-0123456789ab" },
        ]
      ),
      HEALTH_JSON: healthJson ?? health(serving),
    },
    stubs: { gcloud: `printf '%s' "$SERVICE_JSON"`, curl: `printf '%s' "$HEALTH_JSON"` },
  });
}

test("a breaking migration deploys once prod serves its parent, and the run records it", () => {
  const repo = migrationRepo();
  const run = runGate(repo, { applied: repo.base, serving: repo.stopReading });
  assert.equal(run.code, 0, run.out);
  assert.equal(
    run.output,
    "migrations=apps/sdp-api/src/db/migrations/postgres/0002_drop_legacy.sql\n"
  );
});

test("a breaking migration is refused while prod serves a commit older than its parent", () => {
  const repo = migrationRepo();
  const run = runGate(repo, { applied: repo.base, serving: repo.base });
  assert.equal(run.code, 1);
  assert.match(
    run.out,
    new RegExp(
      `0002_drop_legacy\\.sql is marked breaking, so it runs only once prod serves ${repo.drop}\\^`
    )
  );
  assert.equal(run.output, "");
});

test("a deploy with no breaking migration pending never reads the serving commit", () => {
  const repo = migrationRepo();
  const run = runGate(repo, { applied: repo.drop, serving: repo.base });
  assert.equal(run.code, 0, run.out);
  assert.deepEqual(run.calls, []);
  assert.equal(run.output, "");
});

test("with the schema position unknown, the gate checks breaking migrations since the last release tag", () => {
  const repo = migrationRepo();
  assert.equal(runGate(repo, { applied: "", serving: repo.base }).code, 1);
  assert.equal(runGate(repo, { applied: "", serving: repo.stopReading }).code, 0);
});

test("the gate fails closed when it cannot tell which commit prod serves", () => {
  const repo = migrationRepo();
  const unreadable = [
    health(repo.stopReading, "sdp-prod-api-public-00039-other"),
    health("local"),
    JSON.stringify({ status: "ready", revision: servingRevision }),
    health("f".repeat(40)),
  ];
  for (const healthJson of unreadable) {
    const run = runGate(repo, { applied: repo.base, healthJson });
    assert.equal(run.code, 1, healthJson);
    assert.match(run.out, /Could not read the commit sdp-prod-api-public-00041-old serves/);
    assert.equal(run.output, "");
  }
  const split = runGate(repo, {
    applied: repo.base,
    serving: repo.stopReading,
    traffic: [
      { revisionName: servingRevision, percent: 50 },
      { revisionName: "sdp-prod-api-public-00042-new", percent: 50 },
    ],
  });
  assert.notEqual(split.code, 0);
  assert.match(split.out, /production traffic is not on exactly one revision/);
  assert.equal(split.output, "");
});

test("a breaking edit to a repeatable view waits for the code before that edit, not the first one", () => {
  const view = `${migrations}/repeatable/legacy_view.sql`;
  const { dir, commit } = scratchRepo("breaking-gate-view-");
  const base = commit("base", {
    "app.txt": "reads old_col\n",
    [view]: "CREATE VIEW legacy AS SELECT id, old_col FROM t;\n",
  });
  commit("expand the view", {
    [view]: "CREATE VIEW legacy AS SELECT id, old_col, new_col FROM t;\n",
  });
  const stopReading = commit("stop reading old_col", { "app.txt": "reads new_col\n" });
  const contract = commit("drop old_col from the view", {
    [view]: "-- sdp:migration-compat: breaking\nCREATE VIEW legacy AS SELECT id, new_col FROM t;\n",
  });
  const repo = { dir, head: contract };

  const refused = runGate(repo, { applied: base, serving: base });
  assert.equal(refused.code, 1, refused.out);
  assert.match(
    refused.out,
    new RegExp(
      `legacy_view\\.sql is marked breaking, so it runs only once prod serves ${contract}\\^`
    )
  );
  assert.equal(runGate(repo, { applied: base, serving: stopReading }).code, 0);
});

test("an approval run deploys while prod is held only when dispatched with clear_hold", () => {
  const approval = fs.readFileSync(
    path.resolve(here, "../.github/workflows/apply-prod-migrations.yml"),
    "utf8"
  );
  assert.match(
    approval,
    /\n {6}clear_hold:\n\s+description: "[^"\n]+"\n\s+type: boolean\n\s+required: false\n\s+default: false\n/
  );
  assert.match(
    approval,
    /\n\s+approved_schema: true\n\s+clear_hold: \$\{\{ inputs\.clear_hold \}\}\n/
  );
  const refuse = "Refuse while prod is held unless this run lifts the hold";
  const refuseAt = approval.indexOf(`- name: ${refuse}`);
  assert.ok(approval.indexOf("- name: Set up gcloud") < refuseAt);
  assert.ok(refuseAt < approval.indexOf("  approve:"));

  const held = { gcloud: `printf '%s' '${deploySha}'` };
  const refused = runStep(refuse, { source: approval, env: { CLEAR_HOLD: "false" }, stubs: held });
  assert.equal(refused.code, 1);
  assert.match(refused.out, /Dispatch this workflow again with clear_hold/);
  const lifting = runStep(refuse, { source: approval, env: { CLEAR_HOLD: "true" }, stubs: held });
  assert.equal(lifting.code, 0, lifting.out);
  assert.match(lifting.summary, /lifts the hold once its canary passes/);
  const unheld = runStep(refuse, {
    source: approval,
    env: { CLEAR_HOLD: "false" },
    stubs: { gcloud: "exit 0" },
  });
  assert.equal(unheld.code, 0, unheld.out);
});

test("a cancel stops the forward deploy, and the restore or hold runs in its own job", () => {
  const deployJob = workflow
    .slice(workflow.indexOf("\n  deploy:\n"), workflow.indexOf("\n  finish:\n"))
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");
  assert.doesNotMatch(deployJob, /always\(\)|cancelled\(\)|failure\(\)|success\(\)/);
  const rollbackJob = workflow.slice(
    workflow.indexOf("\n  finish:\n"),
    workflow.indexOf("\n  release-web:\n")
  );
  assert.match(
    rollbackJob,
    /\n {4}needs: deploy\n {4}if: \$\{\{ always\(\) && needs\.deploy\.outputs\.rollout_started == 'true' \}\}\n/
  );
  assert.match(rollbackJob, /\n {4}environment: production\n/);
  const steps = [...rollbackJob.matchAll(/\n {6}- name: ([^\n]+)\n/g)].map(([, name]) => name);
  assert.deepEqual(steps, [
    "Authenticate to GCP",
    "Set up gcloud",
    "Restore an incomplete rollout or hold prod",
    "Remove candidate traffic tag",
  ]);

  const approval = fs.readFileSync(
    path.resolve(here, "../.github/workflows/apply-prod-migrations.yml"),
    "utf8"
  );
  assert.match(
    approval,
    / {2}deploy:\n[^\n]*\n\s+needs: approve\n(?:\s+#[^\n]*\n)*\s+if: always\(\) && needs\.approve\.result == 'success'\n/
  );
});

test("each promotion records the build it replaced, and a breaking migration retires it", () => {
  const promoteStep = "Promote service and cron with rollback";
  const promoteEnv = {
    ...deployEnv,
    CANDIDATE_REVISION: "sdp-prod-api-public-00042-new",
    IMAGE: "registry.example/api@sha256:new",
  };
  const healthy = JSON.stringify({
    status: "ready",
    revision: "sdp-prod-api-public-00042-new",
    checks: { database: "ok", redis: "ok" },
  });
  const promote = (env) =>
    runStep(promoteStep, {
      env: { ...promoteEnv, ...env },
      stubs: { node: "exit 0", gcloud: "exit 0", curl: `printf '%s' '${healthy}'` },
    });
  const labelCalls = (run) =>
    run.calls.filter((call) => call.includes("sdp_prod_previous_revision"));

  const recorded = promote({
    PREVIOUS_TRAFFIC: "sdp-prod-api-public-00041-old=100",
    BREAKING_MIGRATIONS: "",
  });
  assert.equal(recorded.code, 0, recorded.out);
  assert.deepEqual(labelCalls(recorded), [
    `gcloud run jobs update sdp-prod-api-public-migrate ${scope} --update-labels sdp_prod_previous_revision=sdp-prod-api-public-00041-old`,
  ]);
  const switched = recorded.calls.findIndex((call) => call.includes("update-traffic"));
  const labelled = recorded.calls.findIndex((call) => call.includes("sdp_prod_previous_revision"));
  const cron = recorded.calls.findIndex((call) =>
    call.includes("jobs update sdp-prod-api-public-cron")
  );
  assert.ok(labelled < switched && switched < cron);

  // The switch lands but the new revision never answers: the target must already be set.
  const unhealthy = runStep(promoteStep, {
    env: {
      ...promoteEnv,
      PREVIOUS_TRAFFIC: "sdp-prod-api-public-00041-old=100",
      BREAKING_MIGRATIONS: "",
    },
    stubs: {
      node: "exit 0",
      gcloud: "exit 0",
      curl: `printf '%s' '${healthy.replace("00042-new", "00041-old")}'`,
    },
  });
  assert.notEqual(unhealthy.code, 0);
  assert.match(
    unhealthy.out,
    /Canonical production traffic did not reach sdp-prod-api-public-00042-new/
  );
  assert.deepEqual(labelCalls(unhealthy), [
    `gcloud run jobs update sdp-prod-api-public-migrate ${scope} --update-labels sdp_prod_previous_revision=sdp-prod-api-public-00041-old`,
  ]);

  for (const env of [
    {
      PREVIOUS_TRAFFIC: "sdp-prod-api-public-00041-old=100",
      BREAKING_MIGRATIONS: `${migrations}/0133_drop.sql`,
    },
    {
      PREVIOUS_TRAFFIC: "sdp-prod-api-public-00040-a=50,sdp-prod-api-public-00041-old=50",
      BREAKING_MIGRATIONS: "",
    },
  ]) {
    const cleared = promote(env);
    assert.equal(cleared.code, 0, cleared.out);
    assert.deepEqual(labelCalls(cleared), [
      `gcloud run jobs update sdp-prod-api-public-migrate ${scope} --remove-labels sdp_prod_previous_revision`,
    ]);
  }

  const migrateEnv = {
    ...deployEnv,
    IMAGE: "registry.example/api@sha256:new",
    DEPLOY_IMAGE_SHA: deploySha,
  };
  const breakingRun = runStep("Run database migrations", {
    env: { ...migrateEnv, BREAKING_MIGRATIONS: `${migrations}/0133_drop.sql` },
    stubs: { gcloud: "exit 0" },
  });
  assert.equal(breakingRun.code, 0, breakingRun.out);
  assert.equal(
    breakingRun.calls[0],
    `gcloud run jobs update sdp-prod-api-public-migrate ${scope} --remove-labels sdp_prod_previous_revision`
  );
  assert.ok(breakingRun.calls.findIndex((call) => call.includes("jobs execute")) > 0);
  const plainRun = runStep("Run database migrations", {
    env: { ...migrateEnv, BREAKING_MIGRATIONS: "" },
    stubs: { gcloud: "exit 0" },
  });
  assert.equal(plainRun.code, 0, plainRun.out);
  assert.deepEqual(labelCalls(plainRun), []);
});

const rollbackWorkflow = fs.readFileSync(
  path.resolve(here, "../.github/workflows/rollback-sdp-api-gcp-prod.yml"),
  "utf8"
);
const quickRollback = "Roll back to the previous build";
const servingNew = serviceJson([{ revisionName: "sdp-prod-api-public-00042-new", percent: 100 }]);
const readyRevision = (ready = "True") =>
  JSON.stringify({
    spec: { containers: [{ image: "registry.example/api@sha256:old" }] },
    status: { conditions: [{ type: "Ready", status: ready }] },
  });

function runQuickRollback({
  previous = "sdp-prod-api-public-00041-old",
  hold = "",
  service = servingNew,
  revision = readyRevision(),
  answeringRevision = "sdp-prod-api-public-00041-old",
} = {}) {
  const gcloud = `case "$*" in
  *"sdp_prod_previous_revision)"*) printf '%s' "$PREVIOUS_LABEL" ;;
  *"sdp_prod_hold)"*) printf '%s' "$HOLD_LABEL" ;;
  "run services describe sdp-prod-api-public "*) printf '%s' "$SERVICE_JSON" ;;
  "run revisions describe "*) printf '%s' "$REVISION_JSON" ;;
esac`;
  return runStep(quickRollback, {
    source: rollbackWorkflow,
    env: {
      ...deployEnv,
      GITHUB_RUN_ID: "4242",
      PREVIOUS_LABEL: previous,
      HOLD_LABEL: hold,
      SERVICE_JSON: service,
      REVISION_JSON: revision,
      HEALTH_JSON: health("f".repeat(40), answeringRevision),
    },
    stubs: { gcloud, curl: `printf '%s' "$HEALTH_JSON"` },
  });
}

test("the quick rollback moves traffic, cron and worker back to the previous build and holds prod", () => {
  assert.match(rollbackWorkflow, /^on:\n {2}workflow_dispatch:\n/m);
  assert.match(
    rollbackWorkflow,
    /\nconcurrency:\n {2}group: sdp-api-gcp-deploy-prod\n {2}cancel-in-progress: false\n/
  );
  assert.match(rollbackWorkflow, /\n {4}environment: production\n/);

  const run = runQuickRollback();
  assert.equal(run.code, 0, run.out);
  const mutations = run.calls.filter((call) => /update|remove-labels/.test(call));
  assert.deepEqual(mutations, [
    `gcloud run jobs update sdp-prod-api-public-migrate ${scope} --update-labels sdp_prod_hold=rollback-4242`,
    `gcloud run services update-traffic sdp-prod-api-public ${scope} --to-revisions sdp-prod-api-public-00041-old=100`,
    `gcloud run jobs update sdp-prod-api-public-cron ${scope} --image registry.example/api@sha256:old`,
    `gcloud run services update sdp-prod-worker ${scope} --image registry.example/api@sha256:old`,
    `gcloud run jobs update sdp-prod-api-public-migrate ${scope} --remove-labels sdp_prod_previous_revision`,
  ]);
  assert.equal(run.output, "revision=sdp-prod-api-public-00041-old\n");

  const held = runQuickRollback({ hold: deploySha });
  assert.equal(held.code, 0, held.out);
  assert.ok(!held.calls.some((call) => call.includes("--update-labels sdp_prod_hold")));
});

test("the quick rollback refuses instead of guessing", () => {
  for (const [options, reason] of [
    [{ previous: "" }, /No previous build is recorded/],
    [{ revision: readyRevision("False") }, /is not Ready, so it cannot take traffic back/],
    [
      {
        service: serviceJson([
          { revisionName: "sdp-prod-api-public-00041-old", percent: 50 },
          { revisionName: "sdp-prod-api-public-00042-new", percent: 50 },
        ]),
      },
      /production traffic is not on exactly one revision/,
    ],
  ]) {
    const run = runQuickRollback(options);
    assert.notEqual(run.code, 0, run.out);
    assert.match(run.out, reason);
    assert.ok(!run.calls.some((call) => /update|remove-labels/.test(call)), run.calls.join("\n"));
  }

  const unreached = runQuickRollback({ answeringRevision: "sdp-prod-api-public-00042-new" });
  assert.equal(unreached.code, 1);
  assert.match(unreached.out, /Production traffic did not reach sdp-prod-api-public-00041-old/);
  assert.ok(!unreached.calls.some((call) => call.includes("--remove-labels")));
});

test("re-running the quick rollback after a partial failure finishes cron and worker", () => {
  const run = runQuickRollback({
    hold: "rollback-4241",
    service: serviceJson([{ revisionName: "sdp-prod-api-public-00041-old", percent: 100 }]),
  });
  assert.equal(run.code, 0, run.out);
  assert.match(
    run.out,
    /Traffic is already on sdp-prod-api-public-00041-old; finishing the rollback\./
  );
  const mutations = run.calls.filter((call) => /update|remove-labels/.test(call));
  assert.deepEqual(mutations, [
    `gcloud run services update-traffic sdp-prod-api-public ${scope} --to-revisions sdp-prod-api-public-00041-old=100`,
    `gcloud run jobs update sdp-prod-api-public-cron ${scope} --image registry.example/api@sha256:old`,
    `gcloud run services update sdp-prod-worker ${scope} --image registry.example/api@sha256:old`,
    `gcloud run jobs update sdp-prod-api-public-migrate ${scope} --remove-labels sdp_prod_previous_revision`,
  ]);
});
