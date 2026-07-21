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

test("manual production redeploy always skips builds and migrations", () => {
  assert.doesNotMatch(workflow, /run_migrations:/);
  assert.match(
    workflow,
    /- name: Build and push image\n\s+if: \$\{\{ github\.event_name == 'push' \}\}/
  );
  assert.match(
    workflow,
    /- name: Run database migrations\n\s+if: \$\{\{ github\.event_name == 'push' \}\}/
  );
});

test("candidate is revision-specific and proven ready before promotion", () => {
  assert.match(workflow, /echo "IMAGE=\$\{resolved_image\}" >> "\$\{GITHUB_ENV\}"/);
  assert.match(workflow, /--no-traffic --tag "\$\{candidate_tag\}"/);
  assert.match(workflow, /status\.imageDigest/);
  assert.match(workflow, /"\$\{CANDIDATE_URL\}\/health\/ready"/);
  assert.match(workflow, /\.revision == \$revision/);
  assert.match(workflow, /\.checks\.database == "ok"/);
  assert.match(workflow, /\.checks\.redis == "ok"/);

  const candidateDeploy = workflow.indexOf("- name: Deploy candidate without production traffic");
  const candidateReadiness = workflow.indexOf("- name: Verify candidate readiness");
  const promotion = workflow.indexOf("- name: Promote service and cron with rollback");
  assert.ok(candidateDeploy !== -1 && candidateDeploy < candidateReadiness);
  assert.ok(candidateReadiness < promotion);
});

test("promotion restores service traffic and cron together on failure", () => {
  assert.match(workflow, /PREVIOUS_TRAFFIC=/);
  assert.match(workflow, /PREVIOUS_CRON_IMAGE=/);
  assert.match(workflow, /trap rollback ERR/);
  assert.match(workflow, /--to-revisions "\$\{CANDIDATE_REVISION\}=100"/);
  assert.match(workflow, /--to-revisions "\$\{PREVIOUS_TRAFFIC\}"/);
  assert.match(workflow, /--image "\$\{PREVIOUS_CRON_IMAGE\}"/);

  const promotionStep = workflow.indexOf("- name: Promote service and cron with rollback");
  const promotion = workflow.indexOf("--to-revisions", promotionStep);
  const canonicalReadiness = workflow.indexOf('"https://api.solana.com/health/ready"', promotion);
  const cronUpdate = workflow.indexOf("gcloud run jobs update", canonicalReadiness);
  assert.ok(promotion !== -1 && promotion < canonicalReadiness);
  assert.ok(canonicalReadiness < cronUpdate);
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
  assert.match(workflow, /timeout-minutes: 30/);
});
