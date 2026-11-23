import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { parse } from "yaml";

const root = resolve(import.meta.dirname, "..");
const workflow = parse(
  readFileSync(join(root, ".github/workflows/backoffice-mainnet-access.yml"), "utf8")
);

function compose(t, changes) {
  const dir = mkdtempSync(join(tmpdir(), "mainnet-access-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const output = join(dir, "output");
  const result = spawnSync("bash", [join(root, "scripts/ci/compose-mainnet-access-control.sh")], {
    encoding: "utf8",
    env: {
      ...process.env,
      TARGET: "prod",
      ACTION: "reset",
      ORGANIZATION_ID: "org_drill",
      COUNTRY: "",
      OPERATOR: "oncall",
      REASON: "Customer asked to start over",
      TICKET: "HOO-2427",
      GITHUB_OUTPUT: output,
      GITHUB_STEP_SUMMARY: join(dir, "summary"),
      ...changes,
    },
  });
  assert.ifError(result.error);
  return { ...result, output: result.status === 0 ? readFileSync(output, "utf8") : "" };
}

for (const target of ["prod", "stage"]) {
  for (const action of ["status", "reset", "set-country"]) {
    test(`${target} ${action} composes a scoped command with the correct approval gate`, (t) => {
      const result = compose(t, {
        TARGET: target,
        ACTION: action,
        COUNTRY: action === "set-country" ? "GB" : "",
      });
      assert.equal(result.status, 0, result.stderr);
      assert.match(
        result.output,
        new RegExp(`args=mainnet-access\\|${action}\\|--organization-id\\|org_drill`)
      );
      assert.match(result.output, new RegExp(`gated=${target === "prod" && action !== "status"}`));
      if (action === "status") assert.doesNotMatch(result.output, /--operator|--country/);
      else
        assert.match(
          result.output,
          /--operator\|github:oncall\|--reason\|Customer asked to start over\|--ticket\|HOO-2427/
        );
      if (action === "set-country") assert.match(result.output, /--country\|GB\|/);
    });
  }
}

for (const [label, changes] of [
  ["unknown target", { TARGET: "dev" }],
  ["unknown action", { ACTION: "approve" }],
  ["wrong organization format", { ORGANIZATION_ID: "org_other|--operator" }],
  ["forged operator", { OPERATOR: "oncall|other" }],
  ["missing reason", { REASON: "" }],
  ["argument delimiter", { REASON: "Reason|--ticket|HOO-1" }],
  ["shell substitution", { REASON: "Reason $(touch /tmp/not-executed)" }],
  ["an email in the reason", { REASON: "Asked by jane@example.com" }],
  ["newline", { REASON: "Reason\ngated=false" }],
  ["missing ticket", { TICKET: "" }],
  ["set-country without a country", { ACTION: "set-country" }],
  ["a malformed country", { ACTION: "set-country", COUNTRY: "GBR" }],
  ["a country on reset", { COUNTRY: "GB" }],
]) {
  test(`rejects ${label} before dispatch`, (t) => assert.equal(compose(t, changes).status, 1));
}

test("changes use production approval and the back-office job, never the incident one", () => {
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
  assert.equal(prod.concurrency.group, `sdp-backoffice-ops-run-\${{ inputs.target }}`);
  assert.equal(prod.env.OPS_JOB, "sdp-prod-backoffice-ops");
  assert.equal(stage.env.OPS_JOB, "sdp-stage-backoffice-ops");
});
