import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export function resolveTimingFile() {
  if (process.env.SDP_CI_TIMING_FILE) {
    return process.env.SDP_CI_TIMING_FILE;
  }
  if (process.env.RUNNER_TEMP) {
    return path.join(process.env.RUNNER_TEMP, "sdp-ci-timing.jsonl");
  }
  return path.join(os.tmpdir(), "sdp-ci-timing.jsonl");
}

export function appendRecord(record) {
  const file = resolveTimingFile();
  mkdirSync(path.dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(record)}\n`);
}

export function readRecords() {
  const file = resolveTimingFile();
  if (!existsSync(file)) {
    return [];
  }
  const records = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) {
      continue;
    }
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === "object") {
        records.push(parsed);
      }
    } catch {
      // Malformed lines are ignored: timing must never break CI.
    }
  }
  return records;
}

export function formatSeconds(ms) {
  if (ms === null || ms === undefined) {
    return "n/a";
  }
  if (ms < 1000) {
    return `${Math.round(ms)}ms`;
  }
  const totalSeconds = ms / 1000;
  if (totalSeconds < 60) {
    return `${totalSeconds.toFixed(1)}s`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds - minutes * 60;
  return `${minutes}m${seconds.toFixed(1)}s`;
}

export function writeStepSummary(text) {
  process.stdout.write(`${text}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);
  }
}
