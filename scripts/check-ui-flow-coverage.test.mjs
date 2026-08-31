import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { auditFlowMatrix } from "./check-ui-flow-coverage.mjs";

function fixture({ sections, specs, rows }) {
  const root = mkdtempSync(path.join(tmpdir(), "flow-matrix-"));
  const dashboardDir = path.join(root, "dashboard");
  const specsDir = path.join(root, "tests");
  mkdirSync(dashboardDir);
  mkdirSync(specsDir);
  for (const section of sections) {
    mkdirSync(path.join(dashboardDir, section));
  }
  writeFileSync(path.join(dashboardDir, "layout.tsx"), "");
  for (const spec of specs) {
    writeFileSync(path.join(specsDir, spec), "");
  }
  const matrixPath = path.join(root, "matrix.md");
  writeFileSync(
    matrixPath,
    [
      "| Section | Critical flows | Spec |",
      "| --- | --- | --- |",
      ...rows.map(({ section, spec }) => `| ${section} | flows | ${spec} |`),
      "",
    ].join("\n")
  );
  return { dashboardDir, specsDir, matrixPath };
}

test("a complete matrix passes", () => {
  const problems = auditFlowMatrix(
    fixture({
      sections: ["payments", "wallets"],
      specs: ["payments.e2e.spec.ts"],
      rows: [
        { section: "payments", spec: "payments.e2e.spec.ts" },
        { section: "wallets", spec: "GAP" },
      ],
    })
  );
  assert.deepEqual(problems, []);
});

test("a dashboard section without a row fails", () => {
  const problems = auditFlowMatrix(
    fixture({
      sections: ["payments", "settings"],
      specs: ["payments.e2e.spec.ts"],
      rows: [{ section: "payments", spec: "payments.e2e.spec.ts" }],
    })
  );
  assert.deepEqual(problems, ['dashboard section "settings" has no row in the UI flow matrix']);
});

test("a row referencing a deleted spec fails", () => {
  const problems = auditFlowMatrix(
    fixture({
      sections: ["payments"],
      specs: [],
      rows: [{ section: "payments", spec: "payments.e2e.spec.ts" }],
    })
  );
  assert.deepEqual(problems, [
    'matrix row "payments" references missing spec "payments.e2e.spec.ts"',
  ]);
});

test("a row for a removed section fails", () => {
  const problems = auditFlowMatrix(
    fixture({
      sections: ["payments"],
      specs: ["payments.e2e.spec.ts"],
      rows: [
        { section: "payments", spec: "payments.e2e.spec.ts" },
        { section: "legacy", spec: "GAP" },
      ],
    })
  );
  assert.deepEqual(problems, ['matrix row "legacy" does not match any dashboard section']);
});

test("multi-spec rows check every listed spec", () => {
  const problems = auditFlowMatrix(
    fixture({
      sections: ["payments"],
      specs: ["payments-transfer.e2e.spec.ts"],
      rows: [
        {
          section: "payments",
          spec: "payments-transfer.e2e.spec.ts, payments-recurring.e2e.spec.ts",
        },
      ],
    })
  );
  assert.deepEqual(problems, [
    'matrix row "payments" references missing spec "payments-recurring.e2e.spec.ts"',
  ]);
});

test("duplicate rows for one section fail", () => {
  const problems = auditFlowMatrix(
    fixture({
      sections: ["payments"],
      specs: ["payments.e2e.spec.ts"],
      rows: [
        { section: "payments", spec: "payments.e2e.spec.ts" },
        { section: "payments", spec: "GAP" },
      ],
    })
  );
  assert.deepEqual(problems, ['matrix has duplicate rows for section "payments"']);
});
