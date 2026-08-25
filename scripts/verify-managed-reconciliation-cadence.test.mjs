import assert from "node:assert/strict";
import test from "node:test";

import {
  readManagedReconciliationCadence,
  verifyManagedReconciliationCadence,
} from "../.github/scripts/verify-managed-reconciliation-cadence.mjs";

function jobDescription(values, timeoutSeconds = 120) {
  return {
    spec: {
      template: {
        spec: {
          template: {
            spec: {
              timeoutSeconds,
              containers: [
                {
                  env: values.map(([name, value]) => ({ name, value })),
                },
              ],
            },
          },
        },
      },
    },
  };
}

test("accepts a Cloud Run job whose managed cadence matches Cloud Scheduler", () => {
  const job = jobDescription([
    ["ENVIRONMENT", "production"],
    ["SDP_MANAGED_RECONCILIATION_CRON", "*/3 * * * *"],
    ["SDP_MANAGED_RECONCILIATION_TIMEOUT_SECONDS", "120"],
  ]);

  assert.equal(readManagedReconciliationCadence(job), "*/3 * * * *");
  assert.doesNotThrow(() => verifyManagedReconciliationCadence("*/3 * * * *", job));
});

test("rejects a missing, duplicated, or mismatched managed cadence", () => {
  assert.throws(
    () => verifyManagedReconciliationCadence("*/3 * * * *", jobDescription([])),
    /exactly one non-empty SDP_MANAGED_RECONCILIATION_CRON/
  );
  assert.throws(
    () =>
      verifyManagedReconciliationCadence(
        "*/3 * * * *",
        jobDescription([
          ["SDP_MANAGED_RECONCILIATION_CRON", "*/3 * * * *"],
          ["SDP_MANAGED_RECONCILIATION_CRON", "*/5 * * * *"],
          ["SDP_MANAGED_RECONCILIATION_TIMEOUT_SECONDS", "120"],
        ])
      ),
    /exactly one non-empty SDP_MANAGED_RECONCILIATION_CRON/
  );
  assert.throws(
    () =>
      verifyManagedReconciliationCadence(
        "*/3 * * * *",
        jobDescription([
          ["SDP_MANAGED_RECONCILIATION_CRON", "*/5 * * * *"],
          ["SDP_MANAGED_RECONCILIATION_TIMEOUT_SECONDS", "120"],
        ])
      ),
    /cadence mismatch/
  );
});

test("rejects a missing, duplicated, or mismatched managed timeout", () => {
  const cadence = [["SDP_MANAGED_RECONCILIATION_CRON", "*/3 * * * *"]];
  assert.throws(
    () => verifyManagedReconciliationCadence("*/3 * * * *", jobDescription(cadence)),
    /exactly one positive SDP_MANAGED_RECONCILIATION_TIMEOUT_SECONDS/
  );
  assert.throws(
    () =>
      verifyManagedReconciliationCadence(
        "*/3 * * * *",
        jobDescription([
          ...cadence,
          ["SDP_MANAGED_RECONCILIATION_TIMEOUT_SECONDS", "120"],
          ["SDP_MANAGED_RECONCILIATION_TIMEOUT_SECONDS", "180"],
        ])
      ),
    /exactly one positive SDP_MANAGED_RECONCILIATION_TIMEOUT_SECONDS/
  );
  assert.throws(
    () =>
      verifyManagedReconciliationCadence(
        "*/3 * * * *",
        jobDescription([...cadence, ["SDP_MANAGED_RECONCILIATION_TIMEOUT_SECONDS", "180"]], 120)
      ),
    /timeout mismatch/
  );
});
