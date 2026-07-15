import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  applyTranslations,
  collectMissingTranslations,
  providerHost,
  translateMissingEntries,
  validateCatalogs,
} from "./missing-translations.mjs";

const releaseBranch = process.env.RELEASE_BRANCH ?? "codex/release-main";
const repo = process.env.GITHUB_REPOSITORY;
const token = process.env.GITHUB_TOKEN;
const messagesDir = path.resolve(
  process.env.I18N_MESSAGES_DIR ?? path.join(process.cwd(), "apps/sdp-web/messages")
);
const sourceLocale = process.env.I18N_SOURCE_LOCALE ?? "en";
const dryRun = process.argv.includes("--dry-run");
const model = process.env.TRANSLATION_LLM_MODEL;
const baseUrl = process.env.TRANSLATION_LLM_BASE_URL;

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

function localeExistsAtRef(ref, locale) {
  for (const relativePath of [
    `apps/sdp-web/messages/${locale}.json`,
    `apps/sdp-web/messages/${locale}`,
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

  const newLocales = locales.filter((locale) => !localeExistsAtRef(baseRef, locale));
  return {
    newLocales,
    existingLocales: locales.filter((locale) => !newLocales.includes(locale)),
  };
}

function formatLocales(locales) {
  return locales.length === 0 ? "None" : locales.map((locale) => `\`${locale}\``).join(", ");
}

function summaryMarkdown({
  missing,
  translations = [],
  batches = 0,
  noOp = false,
  newLocales = [],
  existingLocales = [],
}) {
  const counts = groupedCounts(missing);
  const impacted =
    counts.length === 0
      ? "None"
      : counts.map(([locale, count]) => `\`${locale}\` (${count})`).join(", ");
  const files = [...new Set(translations.map((entry) => entry.targetFile))].sort();
  const lines = [
    "<!-- sdp-translation-summary -->",
    "## LLM translation sync",
    "",
    `- Status: **${noOp ? "no-op" : "generated"}**`,
    `- Impacted locales: ${impacted}`,
    `- Newly discovered locales: ${formatLocales(newLocales)}`,
    `- Existing locales updated: ${formatLocales(existingLocales)}`,
    `- Missing strings: ${missing.length}`,
    `- Generated strings: ${translations.length}`,
    `- Provider: \`${providerHost(baseUrl)}\``,
    `- Model: \`${model ?? "not configured"}\``,
    `- Requests: ${batches}`,
    `- Generated files: ${files.length === 0 ? "None" : files.map((file) => `\`${file}\``).join(", ")}`,
    "",
    "Generated values are LLM-assisted and require normal review.",
  ];
  return lines.join("\n");
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

  const comments = await githubRequest(
    "GET",
    `/repos/${repo}/issues/${pullRequest.number}/comments?per_page=100`
  );
  const existing = comments?.find((comment) =>
    comment.body?.includes("<!-- sdp-translation-summary -->")
  );
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

async function main() {
  const inventory = collectMissingTranslations({ messagesDir, sourceLocale });
  const impactedLocales = [...new Set(inventory.missing.map((entry) => entry.locale))].sort();
  const localeClass = classifyLocales(impactedLocales);
  if (inventory.missing.length === 0) {
    validateCatalogs({ messagesDir, sourceLocale });
    const summary = summaryMarkdown({ missing: [], noOp: true });
    console.log(summary);
    writeStepSummary(summary);
    await updateReleasePrComment(summary);
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

  const result = await translateMissingEntries({
    missing: inventory.missing,
    apiKey: process.env.TRANSLATION_LLM_API_KEY,
    baseUrl,
    model,
    maxKeys: Number(process.env.TRANSLATION_LLM_MAX_KEYS ?? 500),
    batchSize: Number(process.env.TRANSLATION_LLM_BATCH_SIZE ?? 50),
    maxRetries: Number(process.env.TRANSLATION_LLM_MAX_RETRIES ?? 2),
  });

  applyTranslations({ messagesDir, translations: result.translations });
  validateCatalogs({ messagesDir, sourceLocale });

  const files = [...new Set(result.translations.map((entry) => entry.targetFile))].sort();
  git(["add", ...files]);
  git(["config", "user.name", process.env.GIT_COMMIT_NAME ?? "github-actions[bot]"]);
  git([
    "config",
    "user.email",
    process.env.GIT_COMMIT_EMAIL ?? "github-actions[bot]@users.noreply.github.com",
  ]);
  git(["commit", "-m", "chore(i18n): translate missing release strings"]);

  const summary = summaryMarkdown({
    missing: inventory.missing,
    translations: result.translations,
    batches: result.batches,
    ...localeClass,
  });
  console.log(summary);
  writeStepSummary(summary);
  await updateReleasePrComment(summary);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
