import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const SOURCE_CATALOG = /^apps\/sdp-web\/messages\/en(?:\.json|\/)/;
const LOCALIZED_CATALOG =
  /^apps\/sdp-web\/messages\/(?!en(?:\.json|\/))[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]+)*(?:\.json|\/)/;

export function checkCatalogChangePolicy({
  changedFiles,
  headBranch,
  headRepository,
  baseRepository,
  releaseBranch = "codex/release-main",
}) {
  const sourceFiles = changedFiles.filter((file) => SOURCE_CATALOG.test(file));
  const localizedFiles = changedFiles.filter((file) => LOCALIZED_CATALOG.test(file));
  const isAutomatedRelease =
    headBranch === releaseBranch && Boolean(headRepository) && headRepository === baseRepository;

  if (localizedFiles.length === 0 || isAutomatedRelease) {
    return {
      sourceFiles,
      localizedFiles,
      mode: localizedFiles.length === 0 ? "source-only" : "automated-release",
    };
  }

  if (sourceFiles.length > 0) {
    throw new Error(
      [
        "Product pull requests must change only English source catalogs.",
        "Remove the localized catalog edits; Eve adds missing translations on the release PR.",
        "Use a dedicated translation-quality PR for localized copy reviews.",
        "",
        `English catalog changes: ${sourceFiles.join(", ")}`,
        `Localized catalog changes: ${localizedFiles.join(", ")}`,
      ].join("\n")
    );
  }

  return { sourceFiles, localizedFiles, mode: "translation-only" };
}

function changedFiles(baseRef) {
  return execFileSync("git", ["diff", "--name-only", "--diff-filter=ACMR", `${baseRef}...HEAD`], {
    encoding: "utf8",
  })
    .split(/\r?\n/)
    .map((file) => file.trim())
    .filter(Boolean);
}

function main() {
  const baseRef = process.env.I18N_BASE_REF ?? "origin/main";
  const headBranch = process.env.I18N_HEAD_BRANCH ?? "";
  const result = checkCatalogChangePolicy({
    changedFiles: changedFiles(baseRef),
    headBranch,
    headRepository: process.env.I18N_HEAD_REPOSITORY,
    baseRepository: process.env.I18N_BASE_REPOSITORY,
    releaseBranch: process.env.I18N_RELEASE_BRANCH,
  });

  if (result.mode === "translation-only") {
    console.log(
      `Dedicated translation PR: ${result.localizedFiles.length} localized catalog file(s) changed.`
    );
  } else if (result.mode === "automated-release") {
    console.log("Automated release PR may update source and localized catalogs together.");
  } else {
    console.log("No localized catalog changes detected.");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
