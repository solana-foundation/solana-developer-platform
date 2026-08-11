const nonBreakingCommitOverrides = new Set([
  // This merged commit retained an inaccurate BREAKING CHANGE footer. Keep the
  // immutable history intact while excluding only that commit from bump selection.
  // biome-ignore lint/security/noSecrets: Public Git commit SHA, not a secret.
  "c3485d8c035d57cbd58c4058e2f4203369441459",
]);

function parseVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);

  if (!match) {
    throw new Error(`Invalid semver version: ${version}`);
  }

  return match.slice(1).map((part) => Number.parseInt(part, 10));
}

export function releaseCommitSemantics(subject, body = "") {
  const match = subject.match(/^([a-z]+)(?:\([^)]+\))?(!)?: .+$/i);

  return {
    type: match?.[1]?.toLowerCase() ?? "other",
    breaking: Boolean(match?.[2]) || body.includes("BREAKING CHANGE"),
  };
}

function bumpLevel(commits) {
  const hasBreakingChange = commits.some(
    (commit) => commit.breaking && !nonBreakingCommitOverrides.has(commit.sha)
  );

  if (hasBreakingChange) {
    return "major";
  }
  if (commits.some((commit) => commit.type === "feat")) {
    return "minor";
  }
  return "patch";
}

function incrementVersion(version, level) {
  const [major, minor, patch] = parseVersion(version);

  switch (level) {
    case "major":
      return `${major + 1}.0.0`;
    case "minor":
      return `${major}.${minor + 1}.0`;
    default:
      return `${major}.${minor}.${patch + 1}`;
  }
}

export function nextReleaseVersion(version, commits) {
  return incrementVersion(version, bumpLevel(commits));
}
