import assert from "node:assert/strict";
import test from "node:test";
import {
  findWorkspaceDependencyCycles,
  forbiddenPackageSourceImport,
  validateModuleBoundaries,
  workspaceImportName,
  workspaceImportPath,
} from "./check-module-boundaries.mjs";

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
