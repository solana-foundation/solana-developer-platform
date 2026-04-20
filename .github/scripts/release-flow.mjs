import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const mode = process.argv[2];
const dryRun = process.argv.includes("--dry-run");

const repo = process.env.GITHUB_REPOSITORY ?? detectRepositoryFromGit();
const token = process.env.GITHUB_TOKEN;

if (!mode || !["prepare", "publish"].includes(mode)) {
  console.error("Usage: node .github/scripts/release-flow.mjs <prepare|publish> [--dry-run]");
  process.exit(1);
}

if (!dryRun && (!repo || !token)) {
  console.error("GITHUB_REPOSITORY and GITHUB_TOKEN are required");
  process.exit(1);
}

const repoRoot = process.cwd();
const packageJsonPath = path.join(repoRoot, "package.json");
const changelogPath = path.join(repoRoot, "CHANGELOG.md");
const manifestPath = path.join(repoRoot, ".github/.release-please-manifest.json");
const releaseBranch = "codex/release-main";

const changelogSections = [
  { key: "feat", heading: "Features" },
  { key: "fix", heading: "Bug Fixes" },
  { key: "perf", heading: "Performance Improvements" },
  { key: "docs", heading: "Documentation" },
  { key: "refactor", heading: "Refactors" },
  { key: "maintenance", heading: "Maintenance" },
  { key: "other", heading: "Other Changes" },
];

function git(args, options = {}) {
  const output = execFileSync("git", args, {
    encoding: "utf8",
    stdio: options.capture === false ? "inherit" : ["ignore", "pipe", "pipe"],
  });

  if (typeof output !== "string") {
    return "";
  }

  return output.trim();
}

function detectRepositoryFromGit() {
  try {
    const remote = git(["remote", "get-url", "origin"]);
    const match =
      remote.match(/github\.com[:/](.+?)(?:\.git)?$/) ??
      remote.match(/^https:\/\/x-access-token:[^@]+@github\.com\/(.+?)(?:\.git)?$/);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function updatePackageVersion(filePath, currentVersion, nextVersion) {
  const current = fs.readFileSync(filePath, "utf8");
  const updated = current.replace(
    new RegExp(`("version"\\s*:\\s*")${escapeRegExp(currentVersion)}(")`),
    `$1${nextVersion}$2`
  );

  if (updated === current) {
    throw new Error(
      `Unable to update package.json version from ${currentVersion} to ${nextVersion}`
    );
  }

  fs.writeFileSync(filePath, updated);
}

function latestReleaseTag() {
  const output = git(["tag", "--list", "v*.*.*", "--sort=-v:refname"]);
  return (
    output
      .split("\n")
      .map((line) => line.trim())
      .find(Boolean) || null
  );
}

function commitRecords(range) {
  // biome-ignore lint/security/noSecrets: git log delimiters use fixed hex markers, not credentials.
  const output = git(["log", "--format=%H%x1f%s%x1f%b%x1e", range]);

  return output
    .split("\x1e")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [sha, subject, body] = entry.split("\x1f");
      return { sha, subject: subject.trim(), body: (body || "").trim() };
    })
    .filter((entry) => !entry.subject.startsWith("chore(main): release "))
    .filter((entry) => entry.subject !== "chore: format release files");
}

function parseConventionalCommit(subject, body) {
  const match = subject.match(/^([a-z]+)(?:\(([^)]+)\))?(!)?: (.+)$/i);
  const prMatch = subject.match(/\(#(\d+)\)$/);
  const prNumber = prMatch ? prMatch[1] : null;
  const breaking = Boolean(match?.[3]) || body.includes("BREAKING CHANGE");

  if (!match) {
    return {
      type: "other",
      description: subject.replace(/\s+\(#\d+\)$/, ""),
      prNumber,
      breaking,
    };
  }

  const [, rawType, scope, , rawDescription] = match;
  const type = rawType.toLowerCase();
  const baseDescription = rawDescription.replace(/\s+\(#\d+\)$/, "").trim();
  const description = scope ? `**${scope}:** ${baseDescription}` : baseDescription;

  return { type, description, prNumber, breaking };
}

function bumpLevel(commits) {
  if (commits.some((commit) => commit.breaking)) {
    return "major";
  }
  if (commits.some((commit) => commit.type === "feat")) {
    return "minor";
  }
  return "patch";
}

function incrementVersion(version, level) {
  const [major, minor, patch] = version.split(".").map((part) => Number.parseInt(part, 10));

  if ([major, minor, patch].some(Number.isNaN)) {
    throw new Error(`Invalid semver version: ${version}`);
  }

  switch (level) {
    case "major":
      return `${major + 1}.0.0`;
    case "minor":
      return `${major}.${minor + 1}.0`;
    default:
      return `${major}.${minor}.${patch + 1}`;
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function compareUrl(fromTag, toTag) {
  if (!fromTag) {
    return `https://github.com/${repo}/releases/tag/${toTag}`;
  }
  return `https://github.com/${repo}/compare/${fromTag}...${toTag}`;
}

function commitUrl(sha) {
  return `https://github.com/${repo}/commit/${sha}`;
}

function prUrl(number) {
  return `https://github.com/${repo}/pull/${number}`;
}

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

function buildSectionMarkdown(version, previousTag, commits) {
  const releaseTag = `v${version}`;
  const date = new Date().toISOString().slice(0, 10);
  const grouped = new Map(changelogSections.map((section) => [section.key, []]));

  for (const commit of commits) {
    const bucket = categorizeCommit(commit.type);
    const shortSha = commit.sha.slice(0, 7);
    const prLink = commit.prNumber ? ` ([#${commit.prNumber}](${prUrl(commit.prNumber)}))` : "";
    grouped
      .get(bucket)
      ?.push(`* ${commit.description}${prLink} ([${shortSha}](${commitUrl(commit.sha)}))`);
  }

  const lines = [`## [${version}](${compareUrl(previousTag, releaseTag)}) (${date})`, ""];

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

function prependChangelog(sectionMarkdown) {
  const existing = fs.readFileSync(changelogPath, "utf8");
  const header = "# Changelog\n";
  if (!existing.startsWith(header)) {
    throw new Error("CHANGELOG.md does not start with '# Changelog'");
  }

  const rest = existing.slice(header.length).replace(/^\n*/, "");
  const updated = `${header}\n${sectionMarkdown}\n${rest}`;
  fs.writeFileSync(changelogPath, updated);
}

async function githubRequest(method, resourcePath, body) {
  const response = await fetch(`https://api.github.com${resourcePath}`, {
    method,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`${method} ${resourcePath} failed: ${response.status} ${text}`);
  }

  if (response.status === 204) {
    return null;
  }

  return response.json();
}

async function upsertReleasePullRequest(version, body) {
  const [owner] = repo.split("/");
  const pulls = await githubRequest(
    "GET",
    `/repos/${repo}/pulls?state=open&base=main&head=${owner}:${encodeURIComponent(releaseBranch)}`
  );

  if (pulls.length > 0) {
    const existing = pulls[0];
    await githubRequest("PATCH", `/repos/${repo}/pulls/${existing.number}`, {
      title: `chore(main): release ${version}`,
      body,
    });
    return existing.number;
  }

  const created = await githubRequest("POST", `/repos/${repo}/pulls`, {
    title: `chore(main): release ${version}`,
    head: releaseBranch,
    base: "main",
    body,
  });

  return created.number;
}

function ensureCleanTree() {
  const status = git(["status", "--short"]);
  if (status.trim()) {
    throw new Error(`Working tree is not clean:\n${status}`);
  }
}

function releasePrBody(version, sectionMarkdown) {
  return `## Summary
- release ${version}
- update the root package version and changelog

## Changelog
${sectionMarkdown}`.trim();
}

function latestCommitSubject() {
  return git(["log", "-1", "--format=%s"]);
}

function tagExists(tagName) {
  const tags = git(["tag", "--list", tagName]);
  return tags
    .split("\n")
    .map((line) => line.trim())
    .includes(tagName);
}

async function prepareRelease() {
  if (latestCommitSubject().startsWith("chore(main): release ")) {
    console.log("Skipping release preparation on release commit");
    return;
  }

  const packageJson = readJson(packageJsonPath);
  const manifest = readJson(manifestPath);
  const previousTag = latestReleaseTag();
  const range = previousTag ? `${previousTag}..HEAD` : "HEAD";
  const parsedCommits = commitRecords(range).map((entry) => ({
    ...entry,
    ...parseConventionalCommit(entry.subject, entry.body),
  }));

  if (parsedCommits.length === 0) {
    console.log("No unreleased commits found");
    return;
  }

  const nextVersion = incrementVersion(packageJson.version, bumpLevel(parsedCommits));
  const sectionMarkdown = buildSectionMarkdown(nextVersion, previousTag, parsedCommits);

  console.log(`Preparing release ${nextVersion}`);
  if (dryRun) {
    console.log(sectionMarkdown);
    return;
  }

  ensureCleanTree();

  git(["checkout", "-B", releaseBranch], { capture: false });

  manifest["."] = nextVersion;

  updatePackageVersion(packageJsonPath, packageJson.version, nextVersion);
  writeJson(manifestPath, manifest);
  prependChangelog(sectionMarkdown);

  const diff = git([
    "status",
    "--short",
    "--",
    "package.json",
    "CHANGELOG.md",
    ".github/.release-please-manifest.json",
  ]);
  if (!diff.trim()) {
    console.log("No release file changes detected");
    return;
  }

  git(["config", "user.name", "github-actions[bot]"], { capture: false });
  // biome-ignore lint/security/noSecrets: Public GitHub Actions bot noreply address, not a secret.
  git(["config", "user.email", "41898282+github-actions[bot]@users.noreply.github.com"], {
    capture: false,
  });
  git(["add", "package.json", "CHANGELOG.md", ".github/.release-please-manifest.json"], {
    capture: false,
  });
  git(["commit", "-m", `chore(main): release ${nextVersion}`], { capture: false });
  git(
    [
      "push",
      `https://x-access-token:${token}@github.com/${repo}.git`,
      `HEAD:${releaseBranch}`,
      "--force",
    ],
    { capture: false }
  );

  const prNumber = await upsertReleasePullRequest(
    nextVersion,
    releasePrBody(nextVersion, sectionMarkdown)
  );
  console.log(`Release PR ready: #${prNumber}`);
}

async function publishRelease() {
  const packageJson = readJson(packageJsonPath);
  const version = packageJson.version;
  const tagName = `v${version}`;
  const subject = latestCommitSubject();

  if (!subject.startsWith(`chore(main): release ${version}`)) {
    console.log(`Skipping release publish for non-release commit: ${subject}`);
    return;
  }

  if (tagExists(tagName)) {
    console.log(`Tag ${tagName} already exists`);
    return;
  }

  const previousTag = latestReleaseTag();

  if (dryRun) {
    console.log(`Would publish ${tagName} after ${previousTag ?? "initial release"}`);
    return;
  }

  git(["config", "user.name", "github-actions[bot]"], { capture: false });
  // biome-ignore lint/security/noSecrets: Public GitHub Actions bot noreply address, not a secret.
  git(["config", "user.email", "41898282+github-actions[bot]@users.noreply.github.com"], {
    capture: false,
  });
  git(["tag", "-a", tagName, "-m", tagName], { capture: false });
  git(["push", `https://x-access-token:${token}@github.com/${repo}.git`, tagName], {
    capture: false,
  });

  const notes = await githubRequest("POST", `/repos/${repo}/releases/generate-notes`, {
    tag_name: tagName,
    previous_tag_name: previousTag ?? undefined,
    target_commitish: git(["rev-parse", "HEAD"]),
  });

  const existingReleases = await githubRequest("GET", `/repos/${repo}/releases?per_page=100`);
  const alreadyPublished = existingReleases.some((release) => release.tag_name === tagName);

  if (alreadyPublished) {
    console.log(`GitHub release ${tagName} already exists`);
    return;
  }

  await githubRequest("POST", `/repos/${repo}/releases`, {
    tag_name: tagName,
    name: tagName,
    body: notes.body,
    draft: false,
    prerelease: false,
    generate_release_notes: false,
  });

  console.log(`Published release ${tagName}`);
}

if (mode === "prepare") {
  await prepareRelease();
} else {
  await publishRelease();
}
