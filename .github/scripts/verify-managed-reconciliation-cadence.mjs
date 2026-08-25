import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const CADENCE_ENV = "SDP_MANAGED_RECONCILIATION_CRON";
const TIMEOUT_ENV = "SDP_MANAGED_RECONCILIATION_TIMEOUT_SECONDS";

function readJobEnvValues(jobDescription, name) {
  const env = jobDescription?.spec?.template?.spec?.template?.spec?.containers?.[0]?.env;
  return Array.isArray(env)
    ? env
        .filter((entry) => entry?.name === name)
        .map((entry) => (typeof entry.value === "string" ? entry.value.trim() : ""))
    : [];
}

export function readManagedReconciliationCadence(jobDescription) {
  const values = readJobEnvValues(jobDescription, CADENCE_ENV);

  if (values.length !== 1 || !values[0]) {
    throw new Error(`Cloud Run job must define exactly one non-empty ${CADENCE_ENV}`);
  }
  return values[0];
}

function readManagedReconciliationTimeoutSeconds(jobDescription) {
  const values = readJobEnvValues(jobDescription, TIMEOUT_ENV);
  const seconds = Number(values[0]);
  if (values.length !== 1 || !Number.isFinite(seconds) || seconds <= 0) {
    throw new Error(`Cloud Run job must define exactly one positive ${TIMEOUT_ENV}`);
  }
  return seconds;
}

function readCloudRunTimeoutSeconds(jobDescription) {
  // `gcloud run jobs describe` uses the Cloud Run v1 shape, whose TaskSpec
  // serializes this field as `timeoutSeconds` (not the v2 `timeout` duration).
  const value = jobDescription?.spec?.template?.spec?.template?.spec?.timeoutSeconds;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error("Cloud Run job must expose a positive task timeout in seconds");
  }
  return seconds;
}

export function verifyManagedReconciliationCadence(schedulerCadence, jobDescription) {
  const schedulerValue = schedulerCadence.trim();
  if (!schedulerValue) {
    throw new Error("Cloud Scheduler returned an empty reconciliation cadence");
  }

  const jobValue = readManagedReconciliationCadence(jobDescription);
  if (schedulerValue !== jobValue) {
    throw new Error(
      `Managed reconciliation cadence mismatch: scheduler=${JSON.stringify(schedulerValue)} job=${JSON.stringify(jobValue)}`
    );
  }
  const configuredTimeout = readManagedReconciliationTimeoutSeconds(jobDescription);
  const jobTimeout = readCloudRunTimeoutSeconds(jobDescription);
  if (configuredTimeout !== jobTimeout) {
    throw new Error(
      `Managed reconciliation timeout mismatch: job=${jobTimeout}s env=${configuredTimeout}s`
    );
  }
  return schedulerValue;
}

function gcloud(args) {
  return execFileSync("gcloud", args, { encoding: "utf8" }).trim();
}

function main([job, region, project]) {
  if (!job || !region || !project) {
    throw new Error("Usage: verify-managed-reconciliation-cadence.mjs <job> <region> <project>");
  }

  const schedulerCadence = gcloud([
    "scheduler",
    "jobs",
    "describe",
    job,
    "--location",
    region,
    "--project",
    project,
    // biome-ignore lint/security/noSecrets: This is a gcloud output selector, not a secret.
    "--format=value(schedule)",
  ]);
  const jobDescription = JSON.parse(
    gcloud([
      "run",
      "jobs",
      "describe",
      job,
      "--region",
      region,
      "--project",
      project,
      "--format=json",
    ])
  );

  const cadence = verifyManagedReconciliationCadence(schedulerCadence, jobDescription);
  console.log(`Verified managed reconciliation cadence for ${job}: ${cadence}`);
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
