import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  collectSourceImports,
  findWorkspaceDependencyCycles,
  forbiddenPackageSourceImport,
  listFiles,
  readModules,
  validateModuleBoundaries,
  workspaceImportName,
  workspaceImportPath,
} from "./check-module-boundaries.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const api = {
  name: "@sdp/api",
  directory: "apps/sdp-api",
  allowedDependencies: [],
  declaredDependencies: [],
};
const integration = {
  name: "@sdp/api-integration",
  directory: "packages/sdp-api-integration",
  allowedDependencies: ["@sdp/api"],
  declaredDependencies: ["@sdp/api"],
};

test("assigns subpath imports to the longest matching workspace package", () => {
  const workspacePackage = workspaceImportName("@sdp/api-integration/helpers", [
    "@sdp/api",
    "@sdp/api-integration",
    "@sdp/api-integration/helpers",
  ]);

  assert.equal(workspacePackage, "@sdp/api-integration/helpers");
});

test("assigns relative imports to their owning workspace package", () => {
  const workspacePackage = workspaceImportPath({
    filePath: "/repo/packages/sdp-custody/src/index.ts",
    specifier: "../../sdp-payments/src/index",
    modules: [
      {
        name: "@sdp/custody",
        sourceDirectory: "/repo/packages/sdp-custody/src",
      },
      {
        name: "@sdp/payments",
        sourceDirectory: "/repo/packages/sdp-payments/src",
      },
    ],
  });

  assert.equal(workspacePackage, "@sdp/payments");
});

test("permits the explicit API test-support facade", () => {
  const errors = validateModuleBoundaries({
    modules: [api, integration],
    appSourceRoots: ["/repo/apps/sdp-api/src"],
    sourceImports: [
      {
        module: integration,
        filePath: "/repo/packages/sdp-api-integration/src/helpers/integration.ts",
        specifier: "@sdp/api/test-support",
      },
    ],
  });

  assert.deepEqual(errors, []);
});

test("rejects package imports of API-private paths", () => {
  const violation = forbiddenPackageSourceImport({
    module: integration,
    filePath: "/repo/packages/sdp-api-integration/src/helpers/integration.ts",
    specifier: "@sdp/api/services/solana",
    appSourceRoots: ["/repo/apps/sdp-api/src"],
  });

  assert.equal(violation, "imports API source outside @sdp/api/test-support");
});

test("rejects relative package imports into application source", () => {
  const violation = forbiddenPackageSourceImport({
    module: integration,
    filePath: "/repo/packages/sdp-api-integration/src/helpers/integration.ts",
    specifier: "../../../../apps/sdp-api/src/db",
    appSourceRoots: ["/repo/apps/sdp-api/src"],
  });

  assert.equal(violation, "reaches into application source through a relative path");
});

test("requires imported workspace packages to be declared", () => {
  const undeclaredIntegration = { ...integration, declaredDependencies: [] };
  const errors = validateModuleBoundaries({
    modules: [api, undeclaredIntegration],
    appSourceRoots: ["/repo/apps/sdp-api/src"],
    sourceImports: [
      {
        module: undeclaredIntegration,
        filePath: "/repo/packages/sdp-api-integration/src/helpers/integration.ts",
        specifier: "@sdp/api/test-support",
      },
    ],
  });

  assert.match(errors.join("\n"), /without declaring @sdp\/api/);
});

test("requires relative imports to declare their owning workspace package", () => {
  const custody = {
    name: "@sdp/custody",
    directory: "packages/sdp-custody",
    sourceDirectory: "/repo/packages/sdp-custody/src",
    allowedDependencies: ["@sdp/types"],
    declaredDependencies: ["@sdp/types"],
  };
  const payments = {
    name: "@sdp/payments",
    directory: "packages/sdp-payments",
    sourceDirectory: "/repo/packages/sdp-payments/src",
    allowedDependencies: [],
    declaredDependencies: [],
  };
  const errors = validateModuleBoundaries({
    modules: [custody, payments],
    appSourceRoots: [],
    sourceImports: [
      {
        module: custody,
        filePath: "/repo/packages/sdp-custody/src/index.ts",
        specifier: "../../sdp-payments/src/index",
      },
    ],
  });

  assert.deepEqual(errors, [
    "/repo/packages/sdp-custody/src/index.ts imports ../../sdp-payments/src/index without declaring @sdp/payments.",
  ]);
});

test("reports one error for a forbidden API test-support import", () => {
  const otherPackage = {
    name: "@sdp/other",
    directory: "packages/sdp-other",
    allowedDependencies: [],
    declaredDependencies: [],
  };
  const errors = validateModuleBoundaries({
    modules: [api, integration, otherPackage],
    appSourceRoots: ["/repo/apps/sdp-api/src"],
    sourceImports: [
      {
        module: otherPackage,
        filePath: "/repo/packages/sdp-other/src/index.ts",
        specifier: "@sdp/api/test-support",
      },
    ],
  });

  assert.deepEqual(errors, [
    "/repo/packages/sdp-other/src/index.ts imports API source outside @sdp/api/test-support: @sdp/api/test-support.",
  ]);
});

test("detects workspace dependency cycles", () => {
  const cycles = findWorkspaceDependencyCycles([
    { name: "@sdp/a", declaredDependencies: ["@sdp/b"] },
    { name: "@sdp/b", declaredDependencies: ["@sdp/a"] },
  ]);

  assert.deepEqual(cycles, [["@sdp/a", "@sdp/b", "@sdp/a"]]);
});

for (const [fileName, runtimeDependencies, accepted] of [
  ["client.test.ts", [], true],
  ["client.ts", [], false],
  ["client.test.ts", ["@sdp/custody"], false],
]) {
  test(`test-only custody edge: ${fileName}, runtime=${runtimeDependencies.length}`, () => {
    const custody = {
      name: "@sdp/custody",
      directory: "packages/sdp-custody",
      allowedDependencies: [],
      declaredDependencies: [],
    };
    const provider = {
      name: "@sdp/provider",
      directory: "packages/sdp-provider",
      allowedDependencies: [],
      allowedTestDependencies: ["@sdp/custody"],
      declaredDependencies: ["@sdp/custody"],
      runtimeDependencies,
    };
    const errors = validateModuleBoundaries({
      modules: [custody, provider],
      appSourceRoots: [],
      sourceImports: [
        {
          module: provider,
          filePath: `/repo/packages/sdp-provider/src/${fileName}`,
          specifier: "@sdp/custody/testing/fireblocks-proposal",
        },
      ],
    });
    assert.equal(errors.length === 0, accepted);
  });
}

test("fails closed when a module's source directory is missing", () => {
  // A declared module whose `src/` was renamed away would otherwise contribute
  // zero imports and the boundary rules for it would silently stop running.
  assert.throws(
    () => listFiles(path.join(repositoryRoot, "packages/sdp-types/renamed-away")),
    /source directory is missing/
  );
});

test("the real walk reads the workspace's imports", () => {
  // The analysis tests above feed hand-built imports; this floors the real
  // walk, so a discovery bug (a broken walk, a renamed `src/` nothing
  // complained about) cannot turn the check into a vacuous pass. The
  // workspace holds far more imports than this floor.
  const imports = collectSourceImports(readModules(repositoryRoot));
  assert.ok(
    imports.length > 10_000,
    `expected the walk to read the workspace, got ${imports.length} imports`
  );
});

test("only modules that declare no source directory are left unscanned", () => {
  // A module skips the walk only by saying so in MODULE_METADATA (today, the
  // vendored root-level `.js` of bigint-buffer); anything else must be found
  // on disk, and the walk above throws when it is not.
  const unscanned = readModules(repositoryRoot)
    .filter((module) => module.sourceDirectory === undefined)
    .map((module) => module.name);

  assert.deepEqual(unscanned, ["bigint-buffer"]);
});
