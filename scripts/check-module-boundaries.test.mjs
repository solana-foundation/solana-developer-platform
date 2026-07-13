import assert from "node:assert/strict";
import test from "node:test";
import {
  findWorkspaceDependencyCycles,
  forbiddenPackageSourceImport,
  validateModuleBoundaries,
} from "./check-module-boundaries.mjs";

const api = {
  name: "@sdp/api",
  directory: "apps/sdp-api",
  declaredDependencies: [],
};
const integration = {
  name: "@sdp/api-integration",
  directory: "packages/sdp-api-integration",
  declaredDependencies: ["@sdp/api"],
};

test("permits the explicit API test-support facade", () => {
  const errors = validateModuleBoundaries({
    modules: [api, integration],
    appSourceRoots: ["/repo/apps/sdp-api/src"],
    sourceReferences: [
      {
        module: integration,
        filePath: "/repo/packages/sdp-api-integration/src/helpers/integration.ts",
        kind: "import",
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

test("reports package-to-app imports once", () => {
  const errors = validateModuleBoundaries({
    modules: [api, integration],
    appSourceRoots: ["/repo/apps/sdp-api/src"],
    sourceReferences: [
      {
        module: integration,
        filePath: "/repo/packages/sdp-api-integration/src/helpers/integration.ts",
        kind: "import",
        specifier: "@sdp/api/services/solana",
      },
    ],
  });

  assert.deepEqual(errors, [
    "/repo/packages/sdp-api-integration/src/helpers/integration.ts imports application source from @sdp/api/services/solana.",
  ]);
});

test("rejects app compatibility re-exports", () => {
  const errors = validateModuleBoundaries({
    modules: [
      { ...api, declaredDependencies: ["@sdp/types"] },
      { name: "@sdp/types", directory: "packages/sdp-types", declaredDependencies: [] },
    ],
    appSourceRoots: ["/repo/apps/sdp-api/src"],
    sourceReferences: [
      {
        module: { ...api, declaredDependencies: ["@sdp/types"] },
        filePath: "/repo/apps/sdp-api/src/lib/legacy.ts",
        kind: "reexport",
        isStar: false,
        specifier: "@sdp/types",
      },
    ],
  });

  assert.match(errors.join("\n"), /app compatibility re-export/);
});

test("requires imported workspace packages to be declared", () => {
  const undeclaredIntegration = { ...integration, declaredDependencies: [] };
  const errors = validateModuleBoundaries({
    modules: [api, undeclaredIntegration],
    appSourceRoots: ["/repo/apps/sdp-api/src"],
    sourceReferences: [
      {
        module: undeclaredIntegration,
        filePath: "/repo/packages/sdp-api-integration/src/helpers/integration.ts",
        kind: "import",
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
