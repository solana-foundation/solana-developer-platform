import assert from "node:assert/strict";
import test from "node:test";
import {
  findWorkspaceDependencyCycles,
  forbiddenPackageSourceImport,
  validateModuleBoundaries,
  workspaceImportName,
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
  ]);

  assert.equal(workspacePackage, "@sdp/api-integration");
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

test("detects workspace dependency cycles", () => {
  const cycles = findWorkspaceDependencyCycles([
    { name: "@sdp/a", declaredDependencies: ["@sdp/b"] },
    { name: "@sdp/b", declaredDependencies: ["@sdp/a"] },
  ]);

  assert.deepEqual(cycles, [["@sdp/a", "@sdp/b", "@sdp/a"]]);
});
