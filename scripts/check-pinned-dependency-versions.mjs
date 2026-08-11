import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const directDependencyFields = ["dependencies", "devDependencies", "optionalDependencies"];
const exactVersion = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const supportedNonRegistrySpecifiers =
  /^(?:workspace:\*|catalog:|file:|link:|git\+|github:|https?:)/;

export function isPinnedVersion(specifier) {
  return exactVersion.test(specifier) || supportedNonRegistrySpecifiers.test(specifier);
}

export function validateManifest(manifest, manifestPath) {
  const violations = [];

  for (const field of directDependencyFields) {
    for (const [name, specifier] of Object.entries(manifest[field] ?? {})) {
      if (!isPinnedVersion(specifier)) {
        violations.push(
          `${manifestPath}: ${field}.${name} must be an exact version (found ${specifier}).`
        );
      }
    }
  }

  for (const [name, specifier] of Object.entries(manifest.workspaces?.catalog ?? {})) {
    if (!exactVersion.test(specifier)) {
      violations.push(
        `${manifestPath}: workspaces.catalog.${name} must be an exact version (found ${specifier}).`
      );
    }
  }

  return violations;
}

export function validatePnpmCatalog(workspaceConfig, workspacePath) {
  const violations = [];
  let inCatalog = false;

  for (const line of workspaceConfig.split("\n")) {
    if (line === "catalog:") {
      inCatalog = true;
      continue;
    }

    if (inCatalog && /^[^\s#]/.test(line)) break;
    if (!inCatalog) continue;

    const entry = line.match(/^ {2}('[^']+'|[^:#]+):\s*(?:'([^']+)'|"([^"]+)"|([^\s#]+))/);
    if (!entry) continue;

    const [, rawName, singleQuoted, doubleQuoted, bare] = entry;
    const name = rawName.replace(/^'|'$/g, "");
    const specifier = singleQuoted ?? doubleQuoted ?? bare;
    if (!exactVersion.test(specifier)) {
      violations.push(
        `${workspacePath}: catalog.${name} must be an exact version (found ${specifier}).`
      );
    }
  }

  return violations;
}

function trackedPackageManifests(repositoryRoot) {
  return execFileSync(
    "git",
    ["-C", repositoryRoot, "ls-files", "-z", "--", "package.json", "**/package.json"],
    { encoding: "utf8" }
  )
    .split("\0")
    .filter(Boolean);
}

export function checkPinnedDependencyVersions(repositoryRoot) {
  const violations = [];

  for (const relativePath of trackedPackageManifests(repositoryRoot)) {
    const manifestPath = path.join(repositoryRoot, relativePath);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    violations.push(...validateManifest(manifest, relativePath));
  }

  const workspacePath = path.join(repositoryRoot, "pnpm-workspace.yaml");
  if (existsSync(workspacePath)) {
    violations.push(
      ...validatePnpmCatalog(readFileSync(workspacePath, "utf8"), "pnpm-workspace.yaml")
    );
  }

  return violations;
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  const repositoryRoot = path.resolve(
    process.argv[2] ?? path.dirname(fileURLToPath(import.meta.url)),
    ".."
  );
  const violations = checkPinnedDependencyVersions(repositoryRoot);

  if (violations.length > 0) {
    console.error("Pinned dependency policy violations:\n");
    console.error(violations.map((violation) => `- ${violation}`).join("\n"));
    process.exitCode = 1;
  } else {
    console.log("Pinned dependency policy passed.");
  }
}
