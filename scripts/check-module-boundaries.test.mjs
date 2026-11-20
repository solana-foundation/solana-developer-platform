import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  findWorkspaceDependencyCycles,
  forbiddenPackageSourceImport,
  listFiles,
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
        manifestPath: "/repo/packages/sdp-custody/package.json",
      },
      {
        name: "@sdp/payments",
        manifestPath: "/repo/packages/sdp-payments/package.json",
      },
    ],
  });

  assert.equal(workspacePackage, "@sdp/payments");
});

test("assigns a relative import into a source-less package by its package root", () => {
  // bigint-buffer has no `src/` to anchor the lookup, so the owning package is
  // resolved from its manifest's directory; dropping that lookup would let an
  // undeclared relative import into the package pass silently.
  const workspacePackage = workspaceImportPath({
    filePath: "/repo/packages/sdp-custody/src/index.ts",
    specifier: "../../bigint-buffer/node.js",
    modules: [
      {
        name: "@sdp/custody",
        manifestPath: "/repo/packages/sdp-custody/package.json",
      },
      {
        name: "bigint-buffer",
        manifestPath: "/repo/packages/bigint-buffer/package.json",
      },
    ],
  });

  assert.equal(workspacePackage, "bigint-buffer");
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
    manifestPath: "/repo/packages/sdp-custody/package.json",
    allowedDependencies: ["@sdp/types"],
    declaredDependencies: ["@sdp/types"],
  };
  const payments = {
    name: "@sdp/payments",
    directory: "packages/sdp-payments",
    manifestPath: "/repo/packages/sdp-payments/package.json",
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

test("fails closed when a module's source directory is missing", () => {
  // A declared module whose `src/` was renamed away must fail the walk rather
  // than quietly contribute zero imports — the boundary rules for it would
  // otherwise silently stop running. `readdirSync` throws ENOENT naming the
  // missing directory; `listFiles` must not swallow it.
  assert.throws(
    () => listFiles(path.join(repositoryRoot, "packages/sdp-types/renamed-away")),
    /ENOENT/
  );
});
