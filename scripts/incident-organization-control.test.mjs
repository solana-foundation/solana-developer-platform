import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { parse } from "yaml";

const root = resolve(import.meta.dirname, "..");
const workflow = parse(
  readFileSync(join(root, ".github/workflows/incident-organization-control.yml"), "utf8")
);

function compose(t, changes) {
  const dir = mkdtempSync(join(tmpdir(), "org-control-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const output = join(dir, "output");
  const result = spawnSync("bash", [join(root, "scripts/ci/compose-organization-control.sh")], {
    encoding: "utf8",
    env: {
      ...process.env,
      TARGET: "prod",
      ACTION: "suspend",
      ORGANIZATION_ID: "org_drill",
      OPERATOR: "oncall",
      REASON: "Authorized local drill",
      TICKET: "PRO-2315",
      EXPECTED_VERSION: "",
      GITHUB_OUTPUT: output,
      GITHUB_STEP_SUMMARY: join(dir, "summary"),
      ...changes,
    },
  });
  assert.ifError(result.error);
  return { ...result, output: result.status === 0 ? readFileSync(output, "utf8") : "" };
}

for (const target of ["prod", "stage"]) {
  for (const action of ["status", "suspend", "resume"]) {
    test(`${target} ${action} composes a scoped command with the correct approval gate`, (t) => {
      const result = compose(t, {
        TARGET: target,
        ACTION: action,
        EXPECTED_VERSION: action === "resume" ? "4" : "",
      });
      assert.equal(result.status, 0, result.stderr);
      assert.match(
        result.output,
        new RegExp(`args=organization-control\\|${action}\\|--organization-id\\|org_drill`)
      );
      assert.match(result.output, new RegExp(`gated=${target === "prod" && action === "resume"}`));
      if (action === "status") assert.doesNotMatch(result.output, /--operator|--expected-version/);
      else
        assert.match(
          result.output,
          /--operator\|github:oncall\|--reason\|Authorized local drill\|--ticket\|PRO-2315/
        );
      if (action === "resume") assert.match(result.output, /--expected-version\|4/);
    });
  }
}

for (const [label, changes] of [
  ["unknown target", { TARGET: "dev" }],
  ["unknown action", { ACTION: "delete" }],
  ["wrong organization format", { ORGANIZATION_ID: "org_other|--operator" }],
  ["forged operator", { OPERATOR: "oncall|other" }],
  ["missing reason", { REASON: "" }],
  ["argument delimiter", { REASON: "Reason|--expected-version|0" }],
  ["shell substitution", { REASON: "Reason $(touch /tmp/not-executed)" }],
  ["newline", { REASON: "Reason\ngated=false" }],
  ["missing ticket", { TICKET: "" }],
  ["missing restore version", { ACTION: "resume" }],
  ["negative restore version", { ACTION: "resume", EXPECTED_VERSION: "-1" }],
  ["version on suspend", { EXPECTED_VERSION: "1" }],
]) {
  test(`rejects ${label} before dispatch`, (t) => assert.equal(compose(t, changes).status, 1));
}

test("restoration uses the existing production approval and execution boundaries", () => {
  const { validate, approve, "run-prod": prod, "run-stage": stage } = workflow.jobs;
  assert.match(validate.if, /github\.ref == 'refs\/heads\/main'/);
  assert.match(validate.if, /github\.repository == 'solana-foundation\/solana-developer-platform'/);
  assert.equal(approve.environment, "release-production");
  assert.equal(approve.if, "needs.validate.outputs.gated == 'true'");
  assert.deepEqual(prod.needs, ["validate", "approve"]);
  assert.match(
    prod.if,
    /needs\.approve\.result == 'success' \|\| needs\.approve\.result == 'skipped'/
  );
  assert.equal(prod.environment, "production");
  assert.deepEqual(stage.needs, ["validate"]);
  assert.equal(prod.concurrency.group, `sdp-incident-ops-run-\${{ inputs.target }}`);
  assert.equal(stage.concurrency.group, prod.concurrency.group);
  assert.equal(workflow.concurrency, undefined);
  assert.equal(prod.env.OPS_JOB, "sdp-prod-incident-ops");
  assert.equal(stage.env.OPS_JOB, "sdp-stage-incident-ops");
});
