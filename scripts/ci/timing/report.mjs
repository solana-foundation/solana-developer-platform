// Aggregates the job timing log into a markdown table on stdout and, when
// running in Actions, $GITHUB_STEP_SUMMARY. Never fails the job: missing or
// malformed timing data degrades to a notice.
// Usage: node scripts/ci/timing/report.mjs
import { formatSeconds, readRecords, writeStepSummary } from "./lib.mjs";

function cell(value) {
  return String(value).replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function pairMarkers(records) {
  const rows = [];
  const openStarts = new Map();
  for (const record of records) {
    if (record.kind === "duration") {
      rows.push({ label: record.label, detail: record.detail, durationMs: record.durationMs });
      continue;
    }
    const startMatch = /^(.*):start$/.exec(record.label ?? "");
    const endMatch = /^(.*):end$/.exec(record.label ?? "");
    if (startMatch) {
      openStarts.set(startMatch[1], record.atEpochMs);
    } else if (endMatch && openStarts.has(endMatch[1])) {
      const startedAtEpochMs = openStarts.get(endMatch[1]);
      openStarts.delete(endMatch[1]);
      rows.push({
        label: endMatch[1],
        detail: "marker pair",
        durationMs: record.atEpochMs - startedAtEpochMs,
      });
    }
  }
  for (const label of openStarts.keys()) {
    rows.push({ label, detail: "start marker without end marker", durationMs: null });
  }
  return rows;
}

try {
  const records = readRecords();
  const jobName = process.env.GITHUB_JOB ? ` — ${process.env.GITHUB_JOB}` : "";
  if (records.length === 0) {
    writeStepSummary(`## CI timing${jobName}\n\nNo timing data was recorded for this job.`);
  } else {
    const rows = pairMarkers(records);
    const lines = [
      `## CI timing${jobName}`,
      "",
      "| Segment | Duration | Detail |",
      "| --- | ---: | --- |",
      ...rows.map(
        (row) =>
          `| ${cell(row.label)} | ${formatSeconds(row.durationMs)} | ${cell(row.detail ?? "")} |`
      ),
    ];
    const earliest = Math.min(
      ...records.map((record) => record.atEpochMs ?? Number.POSITIVE_INFINITY)
    );
    if (Number.isFinite(earliest)) {
      lines.push(
        "",
        `Approximate time from first measurement to this report: ${formatSeconds(Date.now() - earliest)}.`
      );
    }
    writeStepSummary(lines.join("\n"));
  }
} catch (error) {
  console.error(`[timing] report failed: ${error.message}`);
}
