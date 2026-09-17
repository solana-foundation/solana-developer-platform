import { nonBreakingCommitOverrides } from "./release-version.mjs";

export const changelogSections = [
  { key: "feat", heading: "Features" },
  { key: "fix", heading: "Bug Fixes" },
  { key: "revert", heading: "Reverts" },
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
  if (type === "revert") {
    return "revert";
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

/**
 * A revert commit names what it undoes: `git revert` writes "This reverts commit
 * <sha>.", and a hand-written one usually writes the short sha. Reading it lets
 * the notes drop a feature that no longer exists in the release instead of
 * announcing it, which is what 0.79.0 did with the Hercle provider: the feature
 * appeared under Features and its revert appeared separately under the feature's
 * own title, so nothing on the page said it had been pulled.
 */
const REVERTED_SHA = /^This reverts(?: commit)? ([0-9a-f]{7,40})/im;

function revertedShas(commits) {
  const shas = [];
  for (const commit of commits) {
    if (commit.type !== "revert") {
      continue;
    }
    const match = REVERTED_SHA.exec(commit.body ?? "");
    if (match) {
      shas.push(match[1].toLowerCase());
    }
  }
  return shas;
}

function isReverted(sha, revertedList) {
  const value = (sha ?? "").toLowerCase();
  // Either side may be abbreviated, so compare on the shorter length.
  return revertedList.some((reverted) => value.startsWith(reverted) || reverted.startsWith(value));
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
  const reverted = revertedShas(commits);

  for (const commit of commits) {
    // A commit undone inside this same release never shipped, so listing it
    // would advertise something the release does not contain. The revert itself
    // still appears, under Reverts.
    if (commit.type !== "revert" && isReverted(commit.sha, reverted)) {
      continue;
    }
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
