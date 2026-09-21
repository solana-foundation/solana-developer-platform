// Records a single timestamp marker in the job timing log. Pair
// "<name>:start" with "<name>:end" around steps that cannot be wrapped,
// such as composite actions (docker build, codeql, react-doctor).
// Usage: node scripts/ci/timing/mark.mjs <label>
import { appendRecord } from "./lib.mjs";

if (process.argv.length !== 3 || !process.argv[2]) {
  console.error("usage: node scripts/ci/timing/mark.mjs <label>");
  process.exit(2);
}

const label = process.argv[2];
const atEpochMs = Date.now();
appendRecord({
  kind: "marker",
  label,
  atEpochMs,
  job: process.env.GITHUB_JOB ?? null,
});
console.log(`[timing] marker ${label} at ${new Date(atEpochMs).toISOString()}`);
