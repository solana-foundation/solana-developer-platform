import assert from "node:assert/strict";
import test from "node:test";
import {
  isPinnedVersion,
  validateManifest,
  validatePnpmCatalog,
} from "./check-pinned-dependency-versions.mjs";

test("accepts exact and workspace dependency specifiers", () => {
  assert.equal(isPinnedVersion("10.3.1"), true);
  assert.equal(isPinnedVersion("0.3.0-beta.2"), true);
  assert.equal(isPinnedVersion("workspace:*"), true);
  assert.equal(isPinnedVersion("catalog:"), true);
});

test("rejects semver ranges in direct dependency fields", () => {
  const violations = validateManifest(
    {
      dependencies: { pino: "^10.3.1" },
      devDependencies: { jsdom: "30.0.1" },
      peerDependencies: { react: "^19" },
    },
    "apps/example/package.json"
  );

  assert.deepEqual(violations, [
    "apps/example/package.json: dependencies.pino must be an exact version (found ^10.3.1).",
  ]);
});

test("requires Solana Earn packages to come from immutable registry versions", () => {
  const violations = validateManifest(
    {
      dependencies: {
        "@solana/earn": "workspace:*",
        "@solana/earn-kit": "link:../../../solana-earn/packages/kit",
        "@solana/earn-transactions": "0.1.0-beta.1",
      },
      devDependencies: {
        "@solana/earn-core": "catalog:",
        "@solana/earn-test-utils": "catalog:solana-earn",
      },
    },
    "apps/sdp-api/package.json"
  );

  assert.deepEqual(violations, [
    "apps/sdp-api/package.json: dependencies.@solana/earn must use an exact registry version or catalog: (found workspace:*).",
    "apps/sdp-api/package.json: dependencies.@solana/earn-kit must use an exact registry version or catalog: (found link:../../../solana-earn/packages/kit).",
  ]);
});

test("rejects ranges in pnpm catalogs", () => {
  const violations = validatePnpmCatalog(
    "catalog:\n  '@solana/kit': ^6.5.0\n  '@solana/rpc': 6.8.0\n",
    "pnpm-workspace.yaml"
  );

  assert.deepEqual(violations, [
    "pnpm-workspace.yaml: catalog.@solana/kit must be an exact version (found ^6.5.0).",
  ]);
});

test("checks catalogs with alternate valid YAML formatting", () => {
  const violations = validatePnpmCatalog(
    '"catalog": # exact pins only\n    "@solana/kit": "^6.5.0"\n',
    "pnpm-workspace.yaml"
  );

  assert.deepEqual(violations, [
    "pnpm-workspace.yaml: catalog.@solana/kit must be an exact version (found ^6.5.0).",
  ]);
});

test("checks named pnpm catalogs", () => {
  const violations = validatePnpmCatalog(
    "catalogs:\n  solana:\n    '@solana/kit': ^6.5.0\n",
    "pnpm-workspace.yaml"
  );

  assert.deepEqual(violations, [
    "pnpm-workspace.yaml: catalogs.solana.@solana/kit must be an exact version (found ^6.5.0).",
  ]);
});
