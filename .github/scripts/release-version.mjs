export const nonBreakingCommitOverrides = new Set([
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

// Conventional Commits puts a breaking change in a FOOTER: a line that begins
// with "BREAKING CHANGE:" or "BREAKING-CHANGE:". Matching the phrase anywhere in
// the body instead means a commit that merely writes about breaking changes
// declares itself to be one, which is not a hypothetical: the commit that added
// breaking-change reporting to the changelog said its entry "also surfaces in a
// BREAKING CHANGES section on top", and 0.79.0 opened by announcing that commit
// as breaking. This flag also feeds bumpLevel, so once incrementVersion stops
// holding breaking changes to the minor at 1.0, a stray phrase in a body would
// ship a major on its own.
const BREAKING_FOOTER = /^BREAKING[ -]CHANGE:/m;

export function releaseCommitSemantics(subject, body = "") {
  const match = subject.match(/^([a-z]+)(?:\([^)]+\))?(!)?: .+$/i);

  return {
    type: match?.[1]?.toLowerCase() ?? "other",
    breaking: Boolean(match?.[2]) || BREAKING_FOOTER.test(body),
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
