import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { z } from "zod";

const PACKAGE_ROOT = path.resolve(import.meta.dirname, "../..");
const REPOSITORY_ROOT = path.resolve(PACKAGE_ROOT, "../..");
const SKIPPED_DIRECTORIES = new Set(["node_modules", "dist", "coverage", ".next", ".turbo"]);
const PROVIDER_MODULE_IMPORT = /["']@sdp\/payments\/ramps\/providers\/([^/"']+)\/([^"']+)["']/g;

/** Every TypeScript file under `directory`, build output and dependencies aside. */
function typescriptFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return SKIPPED_DIRECTORIES.has(entry.name) ? [] : typescriptFiles(entryPath);
    }
    return /\.(ts|tsx|mts)$/.test(entry.name) ? [entryPath] : [];
  });
}

function repositoryPath(file: string): string {
  return path.relative(REPOSITORY_ROOT, file);
}

describe("ramp provider boundaries", () => {
  it("lets only a provider's webhook processor import its modules, and only its status mapping", () => {
    const outsideFiles = ["apps", "packages"]
      .flatMap((workspaces) => typescriptFiles(path.join(REPOSITORY_ROOT, workspaces)))
      .filter((file) => !file.startsWith(`${PACKAGE_ROOT}${path.sep}`));
    // An empty scan cannot tell "clean" from "scanned nothing": the workspace
    // holds far more files than this floor, so a broken root fails here
    // instead of passing vacuously.
    assert.ok(
      outsideFiles.length > 1000,
      `expected to scan the workspace, walked ${outsideFiles.length} files`
    );
    // The scanner must still see the import it polices, and must not match a
    // non-provider import, or the violations below are empty by accident.
    const scanner = new RegExp(PROVIDER_MODULE_IMPORT.source, PROVIDER_MODULE_IMPORT.flags);
    assert.match(
      'import { mapEvent } from "@sdp/payments/ramps/providers/moonpay/event-status-mapping";',
      scanner
    );
    assert.doesNotMatch('import { ramps } from "@sdp/payments/ramps";', scanner);
    // The exempted surface is real: the Moonpay webhook imports its provider's
    // status mapping, so the walk below holds the shape this rule allows.
    const moonpayWebhook = readFileSync(
      path.join(REPOSITORY_ROOT, "apps/sdp-api/src/services/ramps/webhooks/moonpay.ts"),
      "utf8"
    );
    assert.ok(
      [...moonpayWebhook.matchAll(new RegExp(PROVIDER_MODULE_IMPORT.source, "g"))].length > 0,
      "the moonpay webhook imports its provider's status mapping"
    );

    const violations = outsideFiles.flatMap((file) =>
      [...readFileSync(file, "utf8").matchAll(PROVIDER_MODULE_IMPORT)].flatMap(
        ([, provider, module]) =>
          repositoryPath(file) === `apps/sdp-api/src/services/ramps/webhooks/${provider}.ts` &&
          module.endsWith("-status-mapping")
            ? []
            : [`${repositoryPath(file)} imports providers/${provider}/${module}`]
      )
    );
    assert.deepEqual(violations, []);
  });

  it("exports no provider module but a status mapping", () => {
    const manifest = z
      .object({ exports: z.record(z.string(), z.unknown()) })
      .parse(JSON.parse(readFileSync(path.join(PACKAGE_ROOT, "package.json"), "utf8")));
    const subpaths = Object.keys(manifest.exports);
    // The narrowing below polices a real surface: the package must export
    // something at all, and a provider status mapping to keep allowing.
    assert.ok(subpaths.length > 0, "the package manifest exports subpaths");
    assert.ok(
      subpaths.some(
        (subpath) => subpath.startsWith("./ramps/providers/") && subpath.endsWith("-status-mapping")
      ),
      "the manifest exports a provider status mapping"
    );
    const providerModules = subpaths.filter(
      (subpath) => subpath.startsWith("./ramps/providers/") && !subpath.endsWith("-status-mapping")
    );
    assert.deepEqual(providerModules, []);
  });

  it("never sees the process environment", () => {
    const sources = typescriptFiles(path.join(PACKAGE_ROOT, "src")).filter(
      (file) => !file.endsWith(".test.ts")
    );
    // An empty scan cannot tell "clean" from "scanned nothing": the package's
    // own sources outnumber this floor by far.
    assert.ok(sources.length > 10, `expected package sources, walked ${sources.length} files`);
    const readers = sources
      .filter((file) => /\bprocess\.env\b|\benv\b/.test(readFileSync(file, "utf8")))
      .map(repositoryPath);
    assert.deepEqual(readers, []);
  });
});
