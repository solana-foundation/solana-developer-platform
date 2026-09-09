import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * Shared helpers for the per-package dependency-boundary checks.
 *
 * Extracted from `check-kamino-dependency-boundary.mjs` when Veda needed the
 * same question asked about a different package. Both checks answer "who is
 * allowed to depend on this?", and the interesting half is per-package: Kamino
 * additionally pins the `bigint-buffer` path the API bundle patches, and Veda
 * additionally keeps a PRIVATE registry dependency from spreading.
 */

const ROOT = process.cwd();

function packageJsonFiles(parent) {
  return readdirSync(path.join(ROOT, parent), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(parent, entry.name, "package.json"))
    .filter((file) => {
      try {
        readFileSync(path.join(ROOT, file));
        return true;
      } catch {
        return false;
      }
    });
}

/** Every manifest in the workspace, including the root. */
export function workspaceManifests() {
  return ["package.json", ...packageJsonFiles("apps"), ...packageJsonFiles("packages")];
}

/** Manifests that declare `dependency` in any dependency field. */
export function directConsumers(dependency, manifests = workspaceManifests()) {
  return manifests
    .filter((file) => {
      const manifest = JSON.parse(readFileSync(path.join(ROOT, file), "utf8"));
      return [manifest.dependencies, manifest.devDependencies, manifest.optionalDependencies].some(
        (dependencies) => dependencies && Object.hasOwn(dependencies, dependency)
      );
    })
    .sort();
}

/**
 * Exactly these manifests may declare `dependency`, no more and no fewer.
 *
 * Use for a dependency that must have a single owner — a vendored SDK, a
 * package with a patched transitive dependency, anything where a second
 * consumer would produce an artifact the first one's protections do not cover.
 */
export function assertExactConsumers(dependency, expected) {
  const actual = directConsumers(dependency);
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw new Error(
      `${dependency} dependency boundary changed. Expected ${wanted.join(", ")}; found ${
        actual.join(", ") || "none"
      }.`
    );
  }
}

/**
 * Only these manifests MAY declare `dependency`; none of them has to.
 *
 * The right shape for "no new consumers" when the dependency is still being
 * wired up across a stack of changes: zero consumers is a legitimate state,
 * while an unlisted one never is.
 */
export function assertConsumersWithin(dependency, allowed) {
  const permitted = new Set(allowed);
  const unexpected = directConsumers(dependency).filter((file) => !permitted.has(file));
  if (unexpected.length > 0) {
    throw new Error(
      `${dependency} may only be consumed by ${[...permitted].sort().join(", ")}; found ${unexpected.join(", ")}.`
    );
  }
}
