import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createCommitOnBranch } from "./github-commit-on-branch.mjs";
import {
  agentHost,
  applyTranslations,
  collectMissingTranslations,
  loadTranslationGuidance,
  translateMissingEntries,
  validateCatalogs,
} from "./missing-translations.mjs";

const releaseBranch = process.env.RELEASE_BRANCH ?? "sdp/release-main";
const repo = process.env.GITHUB_REPOSITORY;
const token = process.env.GITHUB_TOKEN;
const messagesDir = path.resolve(
  process.env.I18N_MESSAGES_DIR ?? path.join(process.cwd(), "apps/sdp-web/messages")
);
const sourceLocale = process.env.I18N_SOURCE_LOCALE ?? "en";
const dryRun = process.argv.includes("--dry-run");
const agentUrl = process.env.TRANSLATION_AGENT_URL;
const agentModel = process.env.TRANSLATION_AGENT_MODEL;
const guidanceFile = path.resolve(
  process.env.I18N_TRANSLATION_GUIDANCE ??
    path.join(process.cwd(), ".github/translation-guidance.json")
);
const guidance = loadTranslationGuidance(guidanceFile);

// Set once a summary reaches the release PR. The failure reporter reads it so a
// late throw cannot replace an accurate summary with a bare error.
let summaryReported = false;

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function writeStepSummary(markdown) {
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
  }
}

function groupedCounts(entries) {
  const counts = new Map();
  for (const entry of entries) {
    counts.set(entry.locale, (counts.get(entry.locale) ?? 0) + 1);
  }
  return [...counts.entries()].sort(([left], [right]) => left.localeCompare(right));
}

function localeExistsAtRef(ref, locale, messagesDir) {
  const messagesRelativeDir = path.relative(process.cwd(), messagesDir);
  for (const relativePath of [
    path.join(messagesRelativeDir, `${locale}.json`),
    path.join(messagesRelativeDir, locale),
  ]) {
    try {
      execFileSync("git", ["cat-file", "-e", `${ref}:${relativePath}`], { stdio: "ignore" });
      return true;
    } catch {
      // Try the next catalog shape.
    }
  }
  return false;
}

function classifyLocales(locales) {
  let baseRef;
  try {
    baseRef = git(["describe", "--tags", "--abbrev=0"]);
  } catch {
    return { newLocales: [], existingLocales: locales };
  }

  const newLocales = locales.filter((locale) => !localeExistsAtRef(baseRef, locale, messagesDir));
  return {
    newLocales,
    existingLocales: locales.filter((locale) => !newLocales.includes(locale)),
  };
}

function formatLocales(locales) {
  return locales.length === 0 ? "None" : locales.map((locale) => `\`${locale}\``).join(", ");
}

export function summaryMarkdown({
  missing,
  translations = [],
  batches = 0,
  noOp = false,
  newLocales = [],
  existingLocales = [],
  failures = [],
  residualDrift = [],
}) {
  const counts = groupedCounts(missing);
  const impacted =
    counts.length === 0
      ? "None"
      : counts.map(([locale, count]) => `\`${locale}\` (${count})`).join(", ");
  const files = [...new Set(translations.map((entry) => entry.targetFile))].sort();
  const staleCount = missing.filter((entry) => entry.stale).length;
  const droppedKeys = failures.reduce((total, failure) => total + failure.keys, 0);
  const status = noOp ? "no-op" : failures.length > 0 ? "partial" : "generated";
  const lines = [
    "<!-- sdp-translation-summary -->",
    "## Eve translation sync",
    "",
    `- Status: **${status}**`,
    `- Impacted locales: ${impacted}`,
    `- Newly discovered locales: ${formatLocales(newLocales)}`,
    `- Existing locales updated: ${formatLocales(existingLocales)}`,
    `- Missing strings: ${missing.length - staleCount}`,
    `- Stale strings re-translated: ${staleCount}`,
    `- Generated strings: ${translations.length}`,
    `- Eve agent: \`${agentHost(agentUrl)}\``,
    `- Model: \`${agentModel ?? "configured by Eve"}\``,
    "- Context: product and locale background, translation instructions, terminology, key namespace, and up to 6 nearby catalog entries",
    `- Requests: ${batches}`,
    `- Failed batches: ${
      failures.length === 0
        ? "None"
        : `${failures.length} (${droppedKeys} strings deferred to the next run)`
    }`,
    `- Generated files: ${files.length === 0 ? "None" : files.map((file) => `\`${file}\``).join(", ")}`,
  ];

  if (failures.length > 0) {
    lines.push(
      "",
      "### Failed batches",
      "",
      ...failures.map(
        (failure) => `- \`${failure.locale}\` (${failure.keys} strings): ${failure.reason}`
      )
    );
  }

  if (residualDrift.length > 0) {
    lines.push(
      "",
      `> **${residualDrift.length} pre-existing catalog defect(s) still unrepaired.** They are queued for the next run.`,
      ...residualDrift.slice(0, 20).map((error) => `> - ${error}`)
    );
  }

  lines.push("", "Generated values are LLM-assisted and require normal review.");
  return lines.join("\n");
}

function workflowRunUrl() {
  const server = process.env.GITHUB_SERVER_URL;
  const runId = process.env.GITHUB_RUN_ID;
  return server && repo && runId ? `${server}/${repo}/actions/runs/${runId}` : null;
}

/**
 * The translation job is continue-on-error, so a throw leaves the workflow run
 * green and the failing job buried inside it. Without a comment the release PR
 * carries no trace at all, which is the same invisibility that let the 2026-08
 * stall run for sixteen days. Same marker as summaryMarkdown, so the next run
 * replaces this in place.
 */
export function failureMarkdown(message) {
  const runUrl = workflowRunUrl();
  return [
    "<!-- sdp-translation-summary -->",
    "## Eve translation sync",
    "",
    "- Status: **failed**",
    "- The run stopped before it could report. Whatever it did not commit is queued for the next run.",
    ...(runUrl ? [`- Failing run: ${runUrl}`] : []),
    "",
    "```",
    message,
    "```",
    "",
    "The workflow run is green by design; this job does not gate the push to `main`. Treat this comment as the release gate.",
  ].join("\n");
}

async function githubRequest(method, resourcePath, body) {
  if (!repo || !token) {
    return null;
  }

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
    throw new Error(`${method} ${resourcePath} failed with HTTP ${response.status}`);
  }
  return response.status === 204 ? null : response.json();
}

async function updateReleasePrComment(markdown) {
  if (!repo || !token) {
    return;
  }

  const [owner] = repo.split("/");
  const head = encodeURIComponent(`${owner}:${releaseBranch}`);
  const pulls = await githubRequest(
    "GET",
    `/repos/${repo}/pulls?state=open&base=main&head=${head}`
  );
  const pullRequest = pulls?.[0];
  if (!pullRequest) {
    console.log("No release PR found; skipping translation summary comment");
    return;
  }

  let existing;
  for (let page = 1; ; page += 1) {
    const comments = await githubRequest(
      "GET",
      `/repos/${repo}/issues/${pullRequest.number}/comments?per_page=100&page=${page}`
    );
    existing = comments?.find((comment) =>
      comment.body?.includes("<!-- sdp-translation-summary -->")
    );
    if (existing || !comments || comments.length < 100) {
      break;
    }
  }
  if (existing) {
    await githubRequest("PATCH", `/repos/${repo}/issues/comments/${existing.id}`, {
      body: markdown,
    });
  } else {
    await githubRequest("POST", `/repos/${repo}/issues/${pullRequest.number}/comments`, {
      body: markdown,
    });
  }
}

async function createTranslationCommit(files) {
  const additions = files.map((relativePath) => ({
    path: relativePath,
    contents: fs.readFileSync(path.resolve(relativePath)).toString("base64"),
  }));
  const commit = await createCommitOnBranch({
    repository: repo,
    branch: releaseBranch,
    expectedHeadOid: git(["rev-parse", "HEAD"]),
    headline: "chore(i18n): translate missing release strings",
    additions,
    token,
  });

  console.log(`Created translation commit ${commit.oid}`);
  return commit.oid;
}

/**
 * Catalog defects in values that already exist, ignoring keys nobody has
 * translated yet. Returns the error lines instead of throwing so a run can tell
 * "drift I inherited" from "drift I just caused".
 */
function driftErrors() {
  try {
    validateCatalogs({ messagesDir, sourceLocale, guidance, allowMissing: true });
    return [];
  } catch (error) {
    return String(error instanceof Error ? error.message : error)
      .split("\n")
      .slice(1);
  }
}

async function main() {
  const inventory = collectMissingTranslations({ messagesDir, sourceLocale, guidance });
  const impactedLocales = [...new Set(inventory.missing.map((entry) => entry.locale))].sort();
  const localeClass = classifyLocales(impactedLocales);
  if (inventory.missing.length === 0) {
    validateCatalogs({ messagesDir, sourceLocale, guidance });
    const summary = summaryMarkdown({ missing: [], noOp: true });
    console.log(summary);
    writeStepSummary(summary);
    await updateReleasePrComment(summary);
    summaryReported = true;
    return;
  }

  if (dryRun) {
    const summary = summaryMarkdown({
      missing: inventory.missing,
      ...localeClass,
    });
    console.log(summary);
    writeStepSummary(summary);
    return;
  }

  const inheritedDrift = new Set(driftErrors());

  const result = await translateMissingEntries({
    missing: inventory.missing,
    guidance,
    agentUrl,
    agentUsername: process.env.TRANSLATION_AGENT_USERNAME,
    agentPassword: process.env.TRANSLATION_AGENT_PASSWORD,
    batchSize: Number(process.env.TRANSLATION_AGENT_BATCH_SIZE || 50),
    maxRetries: Number(process.env.TRANSLATION_AGENT_MAX_RETRIES || 2),
  });

  applyTranslations({ messagesDir, translations: result.translations });

  // Every applied value already passed validateAgentTranslations, so anything
  // still flagged here belongs to a batch that failed and kept its old value.
  // Refuse to commit only if this run made things worse; otherwise banking the
  // batches that did succeed is strictly better than discarding all of them.
  const residualDrift = driftErrors();
  const introducedDrift = residualDrift.filter((error) => !inheritedDrift.has(error));
  if (introducedDrift.length > 0) {
    throw new Error(
      `Translation sync introduced new catalog drift:\n${introducedDrift.join("\n")}`
    );
  }

  const messagesRelativeDir = path.relative(process.cwd(), messagesDir);
  const files = [
    ...new Set(
      result.translations.map((entry) => path.join(messagesRelativeDir, entry.targetFile))
    ),
  ].sort();
  if (files.length > 0) {
    await createTranslationCommit(files);
  } else {
    console.log("No translations were generated; skipping commit");
  }

  const summary = summaryMarkdown({
    missing: inventory.missing,
    translations: result.translations,
    batches: result.batches,
    failures: result.failures,
    residualDrift,
    ...localeClass,
  });
  console.log(summary);
  writeStepSummary(summary);
  await updateReleasePrComment(summary);
  summaryReported = true;

  if (result.failures.length > 0) {
    const dropped = result.failures.reduce((total, failure) => total + failure.keys, 0);
    throw new Error(
      `${result.failures.length} batch(es) failed; ${dropped} string(s) deferred to the next run. Committed translations are unaffected.`
    );
  }
}

/**
 * What a failed run should say on the release PR, or null when it should stay
 * quiet. The deferred-batch throw runs after its own summary is posted and that
 * summary says more than this would; every other throw happens before any
 * report exists at all.
 */
export function failureReport(message, { summaryReported: reported }) {
  return reported ? null : failureMarkdown(message);
}

async function reportFailure(error) {
  const message = String(error instanceof Error ? error.message : error);
  console.error(message);
  process.exitCode = 1;

  const failure = failureReport(message, { summaryReported });
  if (!failure) {
    return;
  }

  writeStepSummary(failure);
  try {
    await updateReleasePrComment(failure);
  } catch (reportError) {
    console.error(
      `Could not report the failure on the release PR: ${
        reportError instanceof Error ? reportError.message : reportError
      }`
    );
  }
}

// Importing this module for tests must not run a release. The opt-out is
// deliberately inverted: anything short of an explicit "1" still runs, because
// a translation sync that silently skips itself is the exact failure class this
// script exists to remove.
if (process.env.TRANSLATION_SCRIPT_IMPORT_ONLY !== "1") {
  main().catch(reportFailure);
}
