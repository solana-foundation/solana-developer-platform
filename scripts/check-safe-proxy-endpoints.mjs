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

const ENDPOINT_LISTS = ["callers", "query", "requestHeaders"];

// The members of a space-separated snapshot list that the newer list lacks.
function dropped(before, after) {
  const kept = after.split(" ");
  return before.split(" ").filter((member) => member !== "" && !kept.includes(member));
}

function narrowings(before, after) {
  const narrowed = [];
  for (const list of ENDPOINT_LISTS) {
    const lost = dropped(before[list], after[list]);
    if (lost.length > 0) narrowed.push(`no longer allows ${list} ${lost.join(" ")}`);
  }
  for (const [name, parameter] of Object.entries(before.parameters)) {
    const now = after.parameters[name];
    if (parameter.startsWith("one_of ") && now?.startsWith("one_of ")) {
      const lost = dropped(parameter, now);
      if (lost.length > 0) narrowed.push(`no longer allows ${name} ${lost.join(" ")}`);
    } else if (now !== parameter) {
      narrowed.push(`changed parameter ${name} from "${parameter}" to "${now}"`);
    }
  }
  return narrowed;
}

export function nonAdditiveChanges(base, head) {
  const errors = [];
  for (const [provider, { hosts, endpoints }] of Object.entries(base)) {
    const lostHosts = head[provider] === undefined ? [] : dropped(hosts, head[provider].hosts);
    if (lostHosts.length > 0) {
      errors.push(`${provider} no longer forwards to host ${lostHosts.join(" ")}.`);
    }
    for (const [target, before] of Object.entries(endpoints)) {
      const after = head[provider]?.endpoints[target];
      if (after === undefined) {
        if (before.status !== "retired") {
          errors.push(`${provider} ${target} was removed without being retired first.`);
        }
        continue;
      }
      if (after.kind !== before.kind) {
        errors.push(`${provider} ${target} changed kind from ${before.kind} to ${after.kind}.`);
      }
      if (before.status !== "retired") {
        errors.push(
          ...narrowings(before, after).map((change) => `${provider} ${target} ${change}.`)
        );
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
