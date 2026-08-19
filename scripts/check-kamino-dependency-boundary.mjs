import { readFileSync } from "node:fs";
import path from "node:path";
import { assertExactConsumers } from "./lib/dependency-boundary.mjs";

const ROOT = process.cwd();
const LOCKFILE = "pnpm-lock.yaml";
const KAMINO_PACKAGE = "packages/sdp-kamino/package.json";
const API_PACKAGE = "apps/sdp-api/package.json";

// Only the private Kamino package may own klend-sdk, and only the API may ship
// that package. A new web/docs/package consumer would create an artifact not
// protected by the API bundle's pure-JS bigint-buffer replacement.
assertExactConsumers("@kamino-finance/klend-sdk", [KAMINO_PACKAGE]);
assertExactConsumers("@sdp/kamino", [API_PACKAGE]);

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

if (bigintVersions.size !== 1 || !bigintVersions.has("1.1.5")) {
  throw new Error(
    `Expected only bigint-buffer@1.1.5 in ${LOCKFILE}; found ${
      [...bigintVersions].join(", ") || "none"
    }.`
  );
}

const allowedParents = new Set([
  "@solana/buffer-layout-utils@0.2.0",
  "@solana/buffer-layout-utils@0.3.0",
]);
const normalizedParents = new Set();
for (const [parent, version] of directParents) {
  if (version !== "1.1.5") {
    throw new Error(`${parent} resolves bigint-buffer to unexpected version ${version}.`);
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
    "@solana/buffer-layout-utils -> bigint-buffer@1.1.5"
);
