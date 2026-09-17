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
 * <sha>.", and a hand-written one usually writes the short sha.
 *
 * Reading it lets the notes describe the FINAL state of the release rather than
 * the path taken to it. 0.79.0 is why: the Hercle provider was added and then
 * reverted in the same range, and the notes announced it under Features while
 * its revert sat under the feature's own title, so nothing said it was pulled.
 *
 * Visibility is recursive, because a revert can itself be reverted. A change is
 * hidden when something that reverts it is still standing; if that revert was
 * itself reverted, the change is back in the release and must be listed again.
 */
const REVERTED_SHA = /^This reverts(?: commit)? ([0-9a-f]{7,40})/im;

function shaMatches(a, b) {
  // Either side may be abbreviated, so compare on the shorter length.
  const x = (a ?? "").toLowerCase();
  const y = (b ?? "").toLowerCase();
  return x.startsWith(y) || y.startsWith(x);
}

function revertTarget(commit, commits) {
  if (commit.type !== "revert") {
    return null;
  }
  const match = REVERTED_SHA.exec(commit.body ?? "");
  if (!match) {
    return null;
  }
  return commits.find((candidate) => shaMatches(candidate.sha, match[1])) ?? null;
}

function buildVisibility(commits) {
  const revertersOf = new Map();
  for (const commit of commits) {
    const target = revertTarget(commit, commits);
    if (target) {
      revertersOf.set(target.sha, [...(revertersOf.get(target.sha) ?? []), commit]);
    }
  }

  const visible = new Map();
  const isVisible = (commit, seen) => {
    const cached = visible.get(commit.sha);
    if (cached !== undefined) {
      return cached;
    }
    if (seen.has(commit.sha)) {
      // A cycle cannot describe a real history; show the commit rather than
      // silently dropping it.
      return true;
    }
    seen.add(commit.sha);
    const standing = (revertersOf.get(commit.sha) ?? []).some((reverter) =>
      isVisible(reverter, seen)
    );
    seen.delete(commit.sha);
    const result = !standing;
    visible.set(commit.sha, result);
    return result;
  };

  return (commit) => isVisible(commit, new Set());
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
  const isVisible = buildVisibility(commits);

  for (const commit of commits) {
    // A change undone inside this same release never shipped, so listing it
    // would advertise something the release does not contain. A revert that was
    // itself reverted is equally not news, and its target comes back.
    if (!isVisible(commit)) {
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
