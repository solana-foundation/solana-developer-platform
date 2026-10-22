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
    const providerModules = Object.keys(manifest.exports).filter(
      (subpath) => subpath.startsWith("./ramps/providers/") && !subpath.endsWith("-status-mapping")
    );
    assert.deepEqual(providerModules, []);
  });

  it("never sees the process environment", () => {
    const readers = typescriptFiles(path.join(PACKAGE_ROOT, "src"))
      .filter((file) => !file.endsWith(".test.ts"))
      .filter((file) => /\bprocess\.env\b|\benv\b/.test(readFileSync(file, "utf8")))
      .map(repositoryPath);
    assert.deepEqual(readers, []);
  });
});
