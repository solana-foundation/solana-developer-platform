import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  checkPinnedDependencyVersions,
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
      peerDependencies: {
        "@solana/earn-provider-acme": "0.1.0-beta.1",
        "@solana/earn-provider-kamino": "catalog:solana-earn",
        react: "^19",
      },
    },
    "apps/sdp-api/package.json"
  );

  assert.deepEqual(violations, [
    "apps/sdp-api/package.json: dependencies.@solana/earn must use an exact registry version or catalog: (found workspace:*).",
    "apps/sdp-api/package.json: dependencies.@solana/earn-kit must use an exact registry version or catalog: (found link:../../../solana-earn/packages/kit).",
  ]);
});

test("rejects mutable Solana Earn peer dependency sources", () => {
  const mutableSources = [
    "^0.1.0",
    "workspace:*",
    "link:../../../solana-earn/packages/kit",
    "file:../../../solana-earn/packages/kit",
    "github:solana-foundation/solana-earn",
    "git+https://github.com/solana-foundation/solana-earn.git",
    "https://artifacts.example/solana-earn.tgz",
  ];

  for (const specifier of mutableSources) {
    assert.deepEqual(
      validateManifest(
        {
          peerDependencies: {
            "@solana/earn-kit": specifier,
            react: "^19",
          },
        },
        "packages/example/package.json"
      ),
      [
        "packages/example/package.json: peerDependencies.@solana/earn-kit must use an exact registry version or catalog: " +
          `(found ${specifier}).`,
      ]
    );
  }
});

test("classifies npm aliases by their target package", () => {
  const violations = validateManifest(
    {
      dependencies: {
        "earn-core": "npm:@solana/earn-core@0.1.0",
      },
      peerDependencies: {
        "earn-kit": "npm:@solana/earn-kit@^0.1.0",
        "earn-transactions": "npm:@solana/earn-transactions@latest",
        "renamed-react": "npm:react@^19",
      },
    },
    "packages/example/package.json"
  );

  assert.deepEqual(violations, [
    "packages/example/package.json: peerDependencies.earn-kit must use an exact registry version or catalog: " +
      "(found npm:@solana/earn-kit@^0.1.0).",
    "packages/example/package.json: peerDependencies.earn-transactions must use an exact registry version or catalog: " +
      "(found npm:@solana/earn-transactions@latest).",
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

/** A throwaway tracked git repo; the caller removes it in a finally. */
function trackedRepo(files) {
  const root = mkdtempSync(path.join(tmpdir(), "pinned-deps-"));
  execFileSync("git", ["init", root]);
  for (const [file, content] of Object.entries(files)) {
    const target = path.join(root, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  // `git ls-files` reads the index, so the fixtures must be tracked to be
  // discovered — the same way the real check sees this repo.
  execFileSync("git", ["-C", root, "add", "-A"]);
  return root;
}

test("the repo walk flags a range dependency and a catalog range end to end", () => {
  const root = trackedRepo({
    "package.json": JSON.stringify({
      name: "fixture-root",
      private: true,
      dependencies: { pino: "^10.3.1" },
    }),
    "apps/example/package.json": JSON.stringify({
      name: "fixture-app",
      dependencies: { "@solana/earn": "workspace:*" },
    }),
    "pnpm-workspace.yaml": "catalog:\n  '@solana/kit': ^6.5.0\n",
  });

  try {
    const violations = checkPinnedDependencyVersions(root);
    assert.deepEqual(violations, [
      "apps/example/package.json: dependencies.@solana/earn must use an exact registry version or catalog: (found workspace:*).",
      "package.json: dependencies.pino must be an exact version (found ^10.3.1).",
      "pnpm-workspace.yaml: catalog.@solana/kit must be an exact version (found ^6.5.0).",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a missing pnpm-workspace.yaml is a violation, not a silent skip", () => {
  const root = trackedRepo({
    "package.json": JSON.stringify({
      name: "fixture-root",
      dependencies: { pino: "10.3.1" },
    }),
  });

  try {
    assert.deepEqual(checkPinnedDependencyVersions(root), [
      "pnpm-workspace.yaml is missing: the catalog exact-pin policy cannot be enforced.",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an empty manifest listing fails the walk instead of passing vacuously", () => {
  const root = mkdtempSync(path.join(tmpdir(), "pinned-deps-"));
  try {
    execFileSync("git", ["init", root]);
    assert.throws(() => checkPinnedDependencyVersions(root), /found no package\.json manifests/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
