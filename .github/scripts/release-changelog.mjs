import { nonBreakingCommitOverrides } from "./release-version.mjs";

export const changelogSections = [
  { key: "feat", heading: "Features" },
  { key: "fix", heading: "Bug Fixes" },
  { key: "perf", heading: "Performance Improvements" },
  { key: "docs", heading: "Documentation" },
  { key: "refactor", heading: "Refactors" },
  { key: "maintenance", heading: "Maintenance" },
  { key: "other", heading: "Other Changes" },
];

function categorizeCommit(type) {
  if (type === "feat") {
    return "feat";
  }
  if (type === "fix") {
    return "fix";
  }
  if (type === "perf") {
    return "perf";
  }
  if (type === "docs") {
    return "docs";
  }
  if (type === "refactor") {
    return "refactor";
  }
  if (["ci", "build", "chore", "test"].includes(type)) {
    return "maintenance";
  }
  return "other";
}

function compareUrl(repo, fromTag, toTag) {
  if (!fromTag) {
    return `https://github.com/${repo}/releases/tag/${toTag}`;
  }
  return `https://github.com/${repo}/compare/${fromTag}...${toTag}`;
}

function commitUrl(repo, sha) {
  return `https://github.com/${repo}/commit/${sha}`;
}

function prUrl(repo, number) {
  return `https://github.com/${repo}/pull/${number}`;
}

export function buildSectionMarkdown(repo, version, previousTag, commits) {
  const releaseTag = `v${version}`;
  const date = new Date().toISOString().slice(0, 10);
  const grouped = new Map(changelogSections.map((section) => [section.key, []]));
  // Breaking commits keep their entry in the type section AND surface in a
  // dedicated section on top: the version bump already paid for the signal
  // (release-version.mjs), and dropping it here is how 0.75.0–0.77.0 shipped
  // breaking changes filed silently under Features. The same override set the
  // bump honors applies, so a commit judged non-breaking is not flagged.
  const breakingEntries = [];

  for (const commit of commits) {
    const bucket = categorizeCommit(commit.type);
    const shortSha = commit.sha.slice(0, 7);
    const prLink = commit.prNumber
      ? ` ([#${commit.prNumber}](${prUrl(repo, commit.prNumber)}))`
      : "";
    const entry = `* ${commit.description}${prLink} ([${shortSha}](${commitUrl(repo, commit.sha)}))`;
    grouped.get(bucket)?.push(entry);
    if (commit.breaking && !nonBreakingCommitOverrides.has(commit.sha)) {
      breakingEntries.push(entry);
    }
  }

  const lines = [`## [${version}](${compareUrl(repo, previousTag, releaseTag)}) (${date})`, ""];

  if (breakingEntries.length > 0) {
    lines.push("### ⚠ BREAKING CHANGES", "");
    lines.push(...breakingEntries, "");
  }

  for (const section of changelogSections) {
    const entries = grouped.get(section.key) || [];
    if (entries.length === 0) {
      continue;
    }
    lines.push(`### ${section.heading}`, "");
    lines.push(...entries, "");
  }

  while (lines.at(-1) === "") {
    lines.pop();
  }

  return `${lines.join("\n")}\n`;
}
