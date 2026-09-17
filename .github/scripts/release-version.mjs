export const nonBreakingCommitOverrides = new Set([
  // This merged commit retained an inaccurate BREAKING CHANGE footer. Keep the
  // immutable history intact while excluding only that commit from bump selection.
  // biome-ignore lint/security/noSecrets: Public Git commit SHA, not a secret.
  "c3485d8c035d57cbd58c4058e2f4203369441459",
  // The commit that ADDED breaking-change reporting. Its body explains the
  // feature in prose ("a breaking commit keeps its entry in its type section
  // and also surfaces in a BREAKING CHANGES section on top"), and the footer
  // detector matched that prose, so the first changelog the new renderer
  // produced announced its own PR as a breaking change. 0.79.0 carries no
  // breaking commit: the range has no "!" subject marker.
  // biome-ignore lint/security/noSecrets: Public Git commit SHA, not a secret.
  "f87bb92d2d7cc5fccabae6ec836cbd0c9b39006c",
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

  // Below 1.0.0, a breaking change takes the minor rather than the major.
  // Reaching 1.0 is a product decision about the stability we are promising
  // integrators, and it also switches on the planned-major policy: after 1.0
  // every breaking change needs a deprecation schedule. A `!` in a commit
  // subject should not make that decision for us. Delete this clause on the
  // release where the team deliberately ships 1.0.0.
  const effectiveLevel = level === "major" && major === 0 ? "minor" : level;

  switch (effectiveLevel) {
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
