import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const mode = process.argv[2];
const dryRun = process.argv.includes("--dry-run");

const repo = process.env.GITHUB_REPOSITORY ?? detectRepositoryFromGit();
const token = process.env.GITHUB_TOKEN;
const [repoOwner] = repo?.split("/") ?? [];
const releaseBranch = "codex/release-main";

if (!["plan", "prepare", "publish"].includes(mode)) {
  console.error("Usage: node .github/scripts/release-flow.mjs <plan|prepare|publish> [--dry-run]");
  process.exit(1);
}

if (["prepare", "publish"].includes(mode) && !dryRun && (!repo || !token)) {
  console.error("GITHUB_REPOSITORY and GITHUB_TOKEN are required");
  process.exit(1);
}

const repoRoot = process.cwd();
const packageJsonPath = path.join(repoRoot, "package.json");
const changelogPath = path.join(repoRoot, "CHANGELOG.md");
const manifestPath = path.join(repoRoot, ".github/.release-please-manifest.json");

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

function releaseTags() {
  const output = git(["tag", "--list", "v*.*.*", "--sort=-v:refname"]);
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function latestReleaseTag() {
  return releaseTags()[0] ?? null;
}

function previousReleaseTag(tagName) {
  const tags = releaseTags();
  const index = tags.indexOf(tagName);

  if (index === -1) {
    return tags[0] ?? null;
  }

  return tags[index + 1] ?? null;
}

function versionFromReleaseTag(tagName) {
  return tagName?.match(/^v(\d+\.\d+\.\d+)$/)?.[1] ?? null;
}

function versionFromReleaseSubject(subject) {
  return subject.match(/^chore\(main\): release (\d+\.\d+\.\d+)/)?.[1] ?? null;
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

function parsedCommitsSince(previousTag) {
  const range = previousTag ? `${previousTag}..HEAD` : "HEAD";
  return commitRecords(range).map((entry) => ({
    ...entry,
    ...parseConventionalCommit(entry.subject, entry.body),
  }));
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
    const error = new Error(`${method} ${resourcePath} failed: ${response.status} ${text}`);
    error.status = response.status;
    throw error;
  }

  if (response.status === 204) {
    return null;
  }

  return response.json();
}

async function githubGraphqlRequest(query, variables) {
  const response = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });

  const text = await response.text();
  let payload = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`GraphQL request failed: ${response.status} ${text}`);
  }

  if (!response.ok || payload.errors?.length) {
    const message = payload.errors?.map((error) => error.message).join("; ") || text;
    throw new Error(`GraphQL request failed: ${response.status} ${message}`);
  }

  return payload.data;
}

async function githubReleaseExists(tagName) {
  try {
    await githubRequest("GET", `/repos/${repo}/releases/tags/${encodeURIComponent(tagName)}`);
    return true;
  } catch (error) {
    if (error.status === 404) {
      return false;
    }

    throw error;
  }
}

function ensureCleanTree() {
  const status = git(["status", "--short"]);
  if (status.trim()) {
    throw new Error(`Working tree is not clean:\n${status}`);
  }
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

function releaseCommitForVersion(version) {
  const releaseCommit = git([
    "log",
    "--format=%H",
    "--extended-regexp",
    `--grep=^chore\\(main\\): release ${escapeRegExp(version)}$`,
    "-1",
  ]);

  return releaseCommit || git(["rev-parse", "HEAD"]);
}

function refreshFromMain() {
  git(["fetch", "origin", "main"], { capture: false });
  git(["reset", "--hard", "origin/main"], { capture: false });
}

function configureGitIdentity() {
  git(["config", "user.name", "github-actions[bot]"], { capture: false });
  // biome-ignore lint/security/noSecrets: Public GitHub Actions bot noreply address, not a secret.
  git(["config", "user.email", "41898282+github-actions[bot]@users.noreply.github.com"], {
    capture: false,
  });
}

function releaseFileAddition(relativePath) {
  return {
    path: relativePath,
    contents: fs.readFileSync(path.join(repoRoot, relativePath)).toString("base64"),
  };
}

async function resetReleaseBranch(baseSha) {
  const encodedBranch = releaseBranch.split("/").map(encodeURIComponent).join("/");
  const refPath = `/repos/${repo}/git/refs/heads/${encodedBranch}`;

  try {
    await githubRequest("PATCH", refPath, { sha: baseSha, force: true });
  } catch (error) {
    // Updating a missing ref returns 422 "Reference does not exist", not 404.
    if (error.status !== 404 && error.status !== 422) {
      throw error;
    }

    await githubRequest("POST", `/repos/${repo}/git/refs`, {
      ref: `refs/heads/${releaseBranch}`,
      sha: baseSha,
    });
  }
}

async function createReleaseBranchCommit(version) {
  const expectedHeadOid = git(["rev-parse", "HEAD"]);
  await resetReleaseBranch(expectedHeadOid);

  const query = `
    mutation CreateReleaseBranchCommit($input: CreateCommitOnBranchInput!) {
      createCommitOnBranch(input: $input) {
        commit {
          oid
          url
        }
      }
    }
  `;

  const data = await githubGraphqlRequest(query, {
    input: {
      branch: {
        repositoryNameWithOwner: repo,
        branchName: releaseBranch,
      },
      expectedHeadOid,
      message: {
        headline: `chore(main): release ${version}`,
      },
      fileChanges: {
        additions: [
          releaseFileAddition("package.json"),
          releaseFileAddition("CHANGELOG.md"),
          releaseFileAddition(".github/.release-please-manifest.json"),
        ],
      },
    },
  });

  const commit = data.createCommitOnBranch.commit;
  console.log(`Created release branch commit ${commit.oid}`);
  return commit.oid;
}

async function enableAutoMerge(pullRequestId, version) {
  const query = `
    mutation EnableReleaseAutoMerge($pullRequestId: ID!, $commitHeadline: String!) {
      enablePullRequestAutoMerge(input: {
        pullRequestId: $pullRequestId,
        mergeMethod: SQUASH,
        commitHeadline: $commitHeadline
      }) {
        pullRequest {
          number
          autoMergeRequest {
            enabledAt
          }
        }
      }
    }
  `;

  try {
    await githubGraphqlRequest(query, {
      pullRequestId,
      commitHeadline: `chore(main): release ${version}`,
    });
  } catch (error) {
    if (error.message.includes("Auto merge is already enabled")) {
      return;
    }
    throw error;
  }
}

async function ensureReleasePrSettings() {
  const repository = await githubRequest("GET", `/repos/${repo}`);
  const missing = [];

  if (!repository.allow_auto_merge) {
    missing.push("Allow auto-merge");
  }
  if (!repository.allow_squash_merge) {
    missing.push("Allow squash merging");
  }
  if (missing.length > 0) {
    throw new Error(`Release PR auto-merge requires repository setting(s): ${missing.join(", ")}`);
  }
}

function releasePrBody(version, sectionMarkdown) {
  return `## Release ${version}

This pull request was generated by the release workflow.

Auto-merge is enabled. After review approval and required checks pass, GitHub will squash-merge this PR and the release workflow will publish the tag and GitHub release.

Required repository settings: Allow auto-merge and Allow squash merging.

${sectionMarkdown}`;
}

async function upsertReleasePullRequest(version, body) {
  const title = `chore(main): release ${version}`;
  const head = `${repoOwner}:${releaseBranch}`;
  const pulls = await githubRequest(
    "GET",
    `/repos/${repo}/pulls?state=open&base=main&head=${encodeURIComponent(head)}`
  );
  const existing = pulls[0];

  const pullRequest = existing
    ? await githubRequest("PATCH", `/repos/${repo}/pulls/${existing.number}`, { title, body })
    : await githubRequest("POST", `/repos/${repo}/pulls`, {
        title,
        body,
        head: releaseBranch,
        base: "main",
        maintainer_can_modify: true,
      });

  await enableAutoMerge(pullRequest.node_id, version);
  return pullRequest.number;
}

async function publishRelease(version, previousTag) {
  const tagName = `v${version}`;
  const targetCommit = releaseCommitForVersion(version);

  if (!tagExists(tagName)) {
    configureGitIdentity();
    git(["tag", "-a", tagName, "-m", tagName, targetCommit], { capture: false });
    git(["push", `https://x-access-token:${token}@github.com/${repo}.git`, tagName], {
      capture: false,
    });
  }

  if (await githubReleaseExists(tagName)) {
    console.log(`GitHub release ${tagName} already exists`);
    return;
  }

  const notes = await githubRequest("POST", `/repos/${repo}/releases/generate-notes`, {
    tag_name: tagName,
    previous_tag_name: previousTag ?? undefined,
    target_commitish: targetCommit,
  });

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

async function planRelease() {
  const subject = latestCommitSubject();
  const packageJson = readJson(packageJsonPath);
  const releaseVersion = versionFromReleaseSubject(subject);

  if (releaseVersion) {
    if (packageJson.version !== releaseVersion) {
      throw new Error(
        `Release commit version ${releaseVersion} does not match package.json ${packageJson.version}`
      );
    }

    const tagName = `v${releaseVersion}`;
    const alreadyPublished = token ? await githubReleaseExists(tagName) : false;
    return {
      reason: alreadyPublished
        ? `Release ${tagName} is already published`
        : `Release ${tagName} needs publishing`,
      shouldRelease: !alreadyPublished,
    };
  }

  const previousTag = latestReleaseTag();
  const previousVersion = versionFromReleaseTag(previousTag);

  if (previousVersion && packageJson.version !== previousVersion) {
    const packageTag = `v${packageJson.version}`;
    const alreadyPublished =
      tagExists(packageTag) && token ? await githubReleaseExists(packageTag) : false;

    return {
      reason: alreadyPublished
        ? `Release ${packageTag} is already published`
        : `Release ${packageTag} needs publishing`,
      shouldRelease: !alreadyPublished,
    };
  }

  if (
    previousTag &&
    previousVersion === packageJson.version &&
    token &&
    !(await githubReleaseExists(previousTag))
  ) {
    return {
      reason: `Release ${previousTag} needs publishing`,
      shouldRelease: true,
    };
  }

  const commits = parsedCommitsSince(previousTag);
  return {
    reason:
      commits.length === 0
        ? "No unreleased commits found"
        : `${commits.length} unreleased commit(s) found`,
    shouldRelease: commits.length > 0,
  };
}

function writePlan(plan) {
  const shouldRelease = plan.shouldRelease ? "true" : "false";
  console.log(`should_release=${shouldRelease}`);
  console.log(`reason=${plan.reason}`);

  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(
      process.env.GITHUB_OUTPUT,
      `should_release=${shouldRelease}\nreason=${plan.reason}\n`
    );
  }
}

async function publishApprovedRelease() {
  const subject = latestCommitSubject();
  const packageJson = readJson(packageJsonPath);
  const releaseVersion = versionFromReleaseSubject(subject);

  if (releaseVersion) {
    if (packageJson.version !== releaseVersion) {
      throw new Error(
        `Release commit version ${releaseVersion} does not match package.json ${packageJson.version}`
      );
    }

    console.log(`Publishing release ${releaseVersion} from release commit`);
    if (dryRun) {
      return;
    }

    await publishRelease(releaseVersion, previousReleaseTag(`v${releaseVersion}`));
    return;
  }

  const previousTag = latestReleaseTag();
  const previousVersion = versionFromReleaseTag(previousTag);

  if (previousVersion && packageJson.version !== previousVersion) {
    console.log(`Publishing package.json release ${packageJson.version} from ahead-of-tag state`);
    if (dryRun) {
      return;
    }

    await publishRelease(packageJson.version, previousReleaseTag(`v${packageJson.version}`));
    return;
  }

  if (
    !dryRun &&
    previousTag &&
    previousVersion === packageJson.version &&
    !(await githubReleaseExists(previousTag))
  ) {
    console.log(`Publishing missing GitHub release ${previousTag}`);
    await publishRelease(packageJson.version, previousReleaseTag(previousTag));
    return;
  }

  console.log(`Skipping release publish for non-release commit: ${subject}`);
}

async function existingReleaseNeedsPublishing(packageJson) {
  const previousTag = latestReleaseTag();
  const previousVersion = versionFromReleaseTag(previousTag);

  if (previousVersion && packageJson.version !== previousVersion) {
    const packageTag = `v${packageJson.version}`;
    return !tagExists(packageTag) || (token ? !(await githubReleaseExists(packageTag)) : true);
  }

  return (
    !dryRun &&
    previousTag &&
    previousVersion === packageJson.version &&
    token &&
    !(await githubReleaseExists(previousTag))
  );
}

async function prepareRelease(attempt = 1) {
  const packageJson = readJson(packageJsonPath);
  const manifest = readJson(manifestPath);

  if (await existingReleaseNeedsPublishing(packageJson)) {
    console.log("Publishing existing release before preparing the next release PR");
    await publishApprovedRelease();
    if (dryRun) {
      return;
    }
  }

  const previousTag = latestReleaseTag();

  const parsedCommits = parsedCommitsSince(previousTag);

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
  await ensureReleasePrSettings();
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

  try {
    await createReleaseBranchCommit(nextVersion);
    const prNumber = await upsertReleasePullRequest(
      nextVersion,
      releasePrBody(nextVersion, sectionMarkdown)
    );
    console.log(`Release PR ready: #${prNumber}`);
  } catch (error) {
    if (attempt >= 3) {
      throw error;
    }

    console.log("Release PR creation failed; refreshing main and retrying release");
    refreshFromMain();
    await prepareRelease(attempt + 1);
    return;
  }
}

if (mode === "plan") {
  writePlan(await planRelease());
} else if (mode === "prepare") {
  await prepareRelease();
} else {
  await publishApprovedRelease();
}
