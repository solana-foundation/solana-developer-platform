import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const LOCKFILE = "pnpm-lock.yaml";
const KAMINO_PACKAGE = "packages/sdp-kamino/package.json";
const API_PACKAGE = "apps/sdp-api/package.json";
const API_DOCKERFILE = "apps/sdp-api/Dockerfile";
const API_DOCKERIGNORE = "apps/sdp-api/Dockerfile.dockerignore";
const SAFE_BIGINT_PACKAGE = "packages/bigint-buffer/package.json";
const SAFE_BIGINT_RESOLUTION = "link:packages/bigint-buffer";

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

const manifests = ["package.json", ...packageJsonFiles("apps"), ...packageJsonFiles("packages")];

function directConsumers(dependency) {
  return manifests.filter((file) => {
    const manifest = JSON.parse(readFileSync(path.join(ROOT, file), "utf8"));
    return [manifest.dependencies, manifest.devDependencies, manifest.optionalDependencies].some(
      (dependencies) => dependencies && Object.hasOwn(dependencies, dependency)
    );
  });
}

function assertExactConsumers(dependency, expected) {
  const actual = directConsumers(dependency).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw new Error(
      `${dependency} dependency boundary changed. Expected ${wanted.join(", ")}; found ${
        actual.join(", ") || "none"
      }.`
    );
  }
}

// Only the private Kamino package may own klend-sdk, and only the API may ship
// that package. bigint-buffer itself is replaced workspace-wide so unbundled
// tools and tests cannot reach the abandoned package's native binding either.
assertExactConsumers("@kamino-finance/klend-sdk", [KAMINO_PACKAGE]);
assertExactConsumers("@sdp/kamino", [API_PACKAGE]);

const safeBigintManifest = JSON.parse(readFileSync(path.join(ROOT, SAFE_BIGINT_PACKAGE), "utf8"));
if (
  safeBigintManifest.name !== "bigint-buffer" ||
  safeBigintManifest.version !== "1.1.6" ||
  safeBigintManifest.private !== true
) {
  throw new Error(
    `${SAFE_BIGINT_PACKAGE} must remain the private bigint-buffer@1.1.6 compatibility package.`
  );
}

const dockerfile = readFileSync(path.join(ROOT, API_DOCKERFILE), "utf8");
for (const requiredCopy of [
  "COPY packages/bigint-buffer/package.json ./packages/bigint-buffer/",
  "COPY packages/bigint-buffer ./packages/bigint-buffer",
]) {
  if (!dockerfile.includes(requiredCopy)) {
    throw new Error(`${API_DOCKERFILE} must include: ${requiredCopy}`);
  }
}
const dockerignore = readFileSync(path.join(ROOT, API_DOCKERIGNORE), "utf8");
if (!dockerignore.includes("!packages/bigint-buffer")) {
  throw new Error(`${API_DOCKERIGNORE} must include packages/bigint-buffer in the build context.`);
}

const lines = readFileSync(path.join(ROOT, LOCKFILE), "utf8").split(/\r?\n/);
const bigintVersions = new Set();
const directParents = new Map();
let inSnapshots = false;
let snapshot = "";

for (const line of lines) {
  const packageHeader = line.match(/^ {2}['"]?bigint-buffer@([^:'"]+)['"]?:$/);
  if (packageHeader) bigintVersions.add(packageHeader[1]);

  if (line === "snapshots:") {
    inSnapshots = true;
    continue;
  }
  if (!inSnapshots) continue;

  const snapshotHeader = line.match(/^ {2}(\S.+):$/);
  if (snapshotHeader) {
    snapshot = snapshotHeader[1].replace(/^['"]|['"]$/g, "");
    continue;
  }

  const bigintDependency = line.match(/^ {6}bigint-buffer:\s+([^\s]+)$/);
  if (bigintDependency) directParents.set(snapshot, bigintDependency[1]);
}

if (bigintVersions.size !== 0) {
  throw new Error(
    `Registry bigint-buffer versions re-entered ${LOCKFILE}: ${[...bigintVersions].join(", ")}.`
  );
}

const allowedParents = new Set([
  "@solana/buffer-layout-utils@0.2.0",
  "@solana/buffer-layout-utils@0.3.0",
]);
const normalizedParents = new Set();
for (const [parent, version] of directParents) {
  if (version !== SAFE_BIGINT_RESOLUTION) {
    throw new Error(
      `${parent} resolves bigint-buffer to ${version}; expected ${SAFE_BIGINT_RESOLUTION}.`
    );
  }
  const normalized = parent.replace(/\(.+$/, "");
  normalizedParents.add(normalized);
  if (!allowedParents.has(normalized)) {
    throw new Error(`Unexpected bigint-buffer dependency path through ${parent}.`);
  }
}

if (
  normalizedParents.size !== allowedParents.size ||
  [...allowedParents].some((parent) => !normalizedParents.has(parent))
) {
  throw new Error(
    `bigint-buffer parent set changed. Expected ${[...allowedParents].join(", ")}; found ${
      [...normalizedParents].join(", ") || "none"
    }.`
  );
}

console.log(
  "Kamino dependency boundary OK: API -> @sdp/kamino -> klend-sdk -> " +
    "@solana/buffer-layout-utils -> workspace bigint-buffer@1.1.6 (pure JS)"
);
