// Keeps the Safe Proxy endpoint declarations reviewable and additive.
// Run: `pnpm check:safe-proxy-endpoints --base <ref>`; `pnpm generate:safe-proxy-endpoints`
// rewrites the snapshot. Run it through the root scripts: it loads the
// declarations from TypeScript source with the workspace `tsx`.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGE_PATH = "packages/sdp-safe-proxy-endpoints";
const SNAPSHOT_PATH = `${PACKAGE_PATH}/endpoints.snapshot.json`;
const USAGE = "Usage: check-safe-proxy-endpoints.mjs (--base <ref> | --write)";

export function nonAdditiveChanges(base, head) {
  const errors = [];
  for (const [provider, { endpoints }] of Object.entries(base)) {
    for (const [target, before] of Object.entries(endpoints)) {
      const after = head[provider]?.endpoints[target];
      if (after === undefined) {
        if (before.status !== "retired") {
          errors.push(`${provider} ${target} was removed without being retired first.`);
        }
      } else if (after.kind !== before.kind) {
        errors.push(`${provider} ${target} changed kind from ${before.kind} to ${after.kind}.`);
      }
    }
  }
  return errors;
}

export function endpointCheckErrors({ problems, rendered, committed, base }) {
  const errors = problems.map((problem) => `${problem}.`);
  if (committed !== rendered) {
    errors.push(`${SNAPSHOT_PATH} is stale. Run pnpm generate:safe-proxy-endpoints.`);
  }
  if (base !== undefined) {
    errors.push(...nonAdditiveChanges(base, JSON.parse(rendered)));
  }
  return errors;
}

function git(args) {
  return execFileSync("git", args, { cwd: REPOSITORY_ROOT, encoding: "utf8" });
}

// Undefined only when the merge-base has no snapshot: the change that adds it.
function readBaseSnapshot(baseRef) {
  const mergeBase = git(["merge-base", baseRef, "HEAD"]).trim();
  if (git(["ls-tree", "--name-only", mergeBase, "--", SNAPSHOT_PATH]).trim() === "") {
    return undefined;
  }
  return JSON.parse(git(["show", `${mergeBase}:${SNAPSHOT_PATH}`]));
}

function importSource(file) {
  return import(pathToFileURL(path.join(REPOSITORY_ROOT, PACKAGE_PATH, "src", file)).href);
}

async function main() {
  const [flag, baseRef, ...rest] = process.argv.slice(2);
  const { renderEndpointSnapshot } = await importSource("snapshot.ts");
  const snapshotFile = path.join(REPOSITORY_ROOT, SNAPSHOT_PATH);

  if (flag === "--write" && baseRef === undefined) {
    writeFileSync(snapshotFile, renderEndpointSnapshot());
    console.log(`Wrote ${SNAPSHOT_PATH}.`);
    return;
  }
  if (flag !== "--base" || baseRef === undefined || rest.length > 0) {
    throw new Error(USAGE);
  }

  const { declarationProblems } = await importSource("declaration-rules.ts");
  const { SAFE_PROXY_PROVIDERS } = await importSource("providers.ts");
  const errors = endpointCheckErrors({
    problems: declarationProblems(SAFE_PROXY_PROVIDERS),
    rendered: renderEndpointSnapshot(),
    committed: readFileSync(snapshotFile, "utf8"),
    base: readBaseSnapshot(baseRef),
  });
  if (errors.length > 0) {
    throw new Error(
      `Safe Proxy endpoint check failed:\n${errors.map((error) => `- ${error}`).join("\n")}`
    );
  }
  console.log("Safe Proxy endpoint check passed.");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
