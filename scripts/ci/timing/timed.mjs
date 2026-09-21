// Times a command: records wall time and exit code to the job timing log,
// mirrors the child's stdio, and propagates its exit code.
// Usage: node scripts/ci/timing/timed.mjs <label> -- <command> [args...]
import { spawnSync } from "node:child_process";
import { appendRecord, formatSeconds } from "./lib.mjs";

const raw = process.argv.slice(2);
const separator = raw.indexOf("--");
if (separator < 1 || separator === raw.length - 1) {
  console.error("usage: node scripts/ci/timing/timed.mjs <label> -- <command> [args...]");
  process.exit(2);
}

const label = raw.slice(0, separator).join(" ");
const command = raw.slice(separator + 1);
const startedAtEpochMs = Date.now();
const startedAtNs = process.hrtime.bigint();
const result = spawnSync(command[0], command.slice(1), {
  stdio: "inherit",
  env: process.env,
});
const durationMs = Number(process.hrtime.bigint() - startedAtNs) / 1e6;

appendRecord({
  kind: "duration",
  label,
  detail: command.join(" "),
  atEpochMs: startedAtEpochMs,
  durationMs,
  exitCode: result.status,
  signal: result.signal ?? null,
  job: process.env.GITHUB_JOB ?? null,
});

const exitDescription = result.status ?? `signal ${result.signal}`;
console.log(`[timing] ${label}: ${formatSeconds(durationMs)} (exit ${exitDescription})`);

if (result.error) {
  console.error(`[timing] failed to spawn command: ${result.error.message}`);
}
process.exit(result.status ?? 1);
