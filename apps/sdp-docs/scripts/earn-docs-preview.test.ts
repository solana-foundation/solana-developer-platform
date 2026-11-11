import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import type { ApiOperation } from "@sdp/api-catalog/reference";
import { earnDocsPreviewOrigin, isEarnDocsPreview } from "@/lib/earn-docs-preview.mjs";
import { enforceEarnPreviewGate, type PublicSurface } from "@/lib/release-channel";
import {
  isPartnerEarnPath,
  mergeEarnPreview,
  resetEarnDocsPreview,
  stageEarnDocsPreview,
} from "./lib/earn-docs-preview";

const PREVIEW = { VERCEL_ENV: "preview", VERCEL_GIT_COMMIT_REF: "earn-docs" };
const OPERATION: ApiOperation = {
  operationId: "listEarnStrategies",
  endpointId: "list-earn-strategies",
  method: "GET",
  path: "/v1/earn/strategies",
  module: "earn",
  action: "earn.read",
  auth: "apiKey",
  takesIdempotencyKey: false,
  summary: "List strategies",
  group: "Discovery",
  description: null,
  deprecated: false,
  parameters: [],
  requestBody: null,
  responses: [{ status: "204", description: "No content", body: { kind: "empty" } }],
  request: { path: "/v1/earn/strategies", body: null },
};
const BASE_REFERENCE = {
  families: [
    { name: "Health", description: "Health", operations: [{ ...OPERATION, module: "core" }] },
  ],
};
const BASE_DOCUMENT = {
  openapi: "3.0.0",
  paths: { "/health": { get: { operationId: "health" } } },
  components: { securitySchemes: { apiKeyAuth: { type: "http", scheme: "bearer" } } },
  tags: [{ name: "Health" }],
};
const BASE_SURFACE: PublicSurface = {
  releaseChannel: "stable",
  modules: ["custody", "payments"],
  rampProviders: [],
  custodyProviders: ["privy"],
  walletCreateDedupe: [
    { provider: "privy", mode: "managed", window: "permanent" },
    { provider: "privy", mode: "byok", window: "permanent" },
  ],
  grantableActions: [{ module: "wallets", verbs: ["read"] }],
  allModules: ["custody", "payments", "earn"],
  allRampProviders: [],
  rateLimits: {
    windowSeconds: 60,
    apiKeyTiers: { standard: 100, elevated: 500, unlimited: 10_000 },
    unauthenticatedPerIp: 20,
  },
};
function previewInput() {
  return {
    partnerOperationIds: [OPERATION.operationId],
    partner: {
      reference: { families: [{ name: "Earn", description: "Earn", operations: [OPERATION] }] },
      document: {
        paths: { [OPERATION.path]: { get: { operationId: OPERATION.operationId } } },
        components: { schemas: { UnrelatedModule: { type: "string" } } },
        tags: [{ name: "Earn" }],
      },
      grantableActions: { module: "earn", verbs: ["read", "manage", "execute"] },
    },
  };
}
function merge(preview: unknown = previewInput()) {
  return mergeEarnPreview(BASE_DOCUMENT, BASE_REFERENCE, BASE_SURFACE, preview);
}

describe("Earn docs branch preview", () => {
  for (const [environment, branch, expected] of [
    ["preview", "earn-docs", true],
    ["production", "earn-docs", false],
    ["development", "earn-docs", false],
    [undefined, "earn-docs", false],
    ["preview", "main", false],
    ["preview", "codex/earn-docs", false],
    ["preview", "earn-docs-extra", false],
    ["preview", undefined, false],
    [undefined, undefined, false],
  ] as const) {
    it(`admits ${environment ?? "local"}/${branch ?? "missing branch"}: ${expected}`, () => {
      const env = { VERCEL_ENV: environment, VERCEL_GIT_COMMIT_REF: branch };
      assert.equal(isEarnDocsPreview(env), expected);
      const staged: PublicSurface = {
        ...BASE_SURFACE,
        earnDocsPreview: true,
        modules: [...BASE_SURFACE.modules, "earn"],
        grantableActions: [...BASE_SURFACE.grantableActions, { module: "earn", verbs: ["read"] }],
      };
      if (!expected) {
        assert.throws(() => enforceEarnPreviewGate(staged, env), /Stale Earn preview artifacts/);
        return;
      }
      const surface = enforceEarnPreviewGate(staged, env);
      assert.equal(surface.modules.includes("earn"), expected);
      assert.equal(
        surface.grantableActions.some(({ module }) => module === "earn"),
        expected
      );
      assert.deepEqual(
        surface.modules.filter((module) => module !== "earn"),
        BASE_SURFACE.modules
      );
    });
  }

  it("leaves ordinary publication manifests unchanged", () => {
    assert.equal(enforceEarnPreviewGate(BASE_SURFACE, {}), BASE_SURFACE);
  });

  it("uses the deployment origin only for the exact branch preview", () => {
    assert.equal(
      earnDocsPreviewOrigin({ ...PREVIEW, VERCEL_URL: "earn-docs-test.vercel.app" }),
      "https://earn-docs-test.vercel.app"
    );
    assert.equal(
      earnDocsPreviewOrigin({
        VERCEL_ENV: "production",
        VERCEL_GIT_COMMIT_REF: "earn-docs",
        VERCEL_URL: "production.vercel.app",
      }),
      undefined
    );
    assert.throws(() => earnDocsPreviewOrigin(PREVIEW), /VERCEL_URL is required/);
    assert.throws(
      () => earnDocsPreviewOrigin({ ...PREVIEW, VERCEL_URL: "preview.vercel.app/unexpected" }),
      /hostname/
    );
  });

  it("adds only Earn and preserves the deployment's other release gates", () => {
    const result = merge();
    assert.deepEqual(result.surface.modules, ["custody", "payments", "earn"]);
    assert.equal(result.surface.releaseChannel, "stable");
    assert.equal(result.surface.earnDocsPreview, true);
    assert.deepEqual(result.surface.rampProviders, []);
    assert.deepEqual(result.document.components, BASE_DOCUMENT.components);
    assert.deepEqual(Object.keys(result.document.paths), ["/health", OPERATION.path]);
    assert.deepEqual(
      result.reference.families.map(({ name }) => name),
      ["Health", "Earn"]
    );
    assert.equal(BASE_SURFACE.modules.includes("earn"), false);
  });

  it("rejects internal Treasury and Programs even if input claims they are partner operations", () => {
    for (const route of [
      "/v1/earn/programs",
      "/v1/earn/vault-deposits",
      "/v1/earn/vault-positions",
    ]) {
      assert.equal(isPartnerEarnPath(route), false);
      const input = previewInput();
      input.partner.document.paths = { [route]: { get: { operationId: OPERATION.operationId } } };
      input.partner.reference.families[0]?.operations.splice(0, 1, { ...OPERATION, path: route });
      assert.throws(() => merge(input), /Internal Earn path/);
    }
  });

  it("refuses reference/OpenAPI coverage drift", () => {
    const input = previewInput();
    input.partnerOperationIds = [];
    assert.throws(() => merge(input), /prospective public operation list/);
    const missing = previewInput();
    missing.partner.document.paths = {};
    assert.throws(() => merge(missing), /coverage differs/);
  });

  it("requires the dual guard before reading or staging files", async () => {
    await assert.rejects(
      stageEarnDocsPreview("/does-not-exist", {
        VERCEL_ENV: "production",
        VERCEL_GIT_COMMIT_REF: "earn-docs",
      }),
      /restricted/
    );
  });

  it("stages partner guides, excludes Treasury, and restores recorded files on reuse", async () => {
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "earn-docs-preview-"));
    const root = path.join(temporary, "apps/sdp-docs");
    const content = path.join(root, "content");
    const generated = path.join(temporary, "apps/sdp-api/generated");
    const rootMeta = JSON.stringify({ pages: ["index", "---Resources---", "reference/api"] });
    try {
      await fs.mkdir(path.join(content, "docs/guides"), { recursive: true });
      await fs.mkdir(path.join(content, "unpublished/earn"), { recursive: true });
      await fs.mkdir(path.join(content, "unpublished/guides"), { recursive: true });
      await fs.mkdir(generated, { recursive: true });
      await fs.writeFile(path.join(content, "docs/meta.json"), rootMeta);
      await fs.writeFile(path.join(content, "docs/guides/embedded-yield.mdx"), "Previous guide");
      await fs.writeFile(
        path.join(content, "unpublished/earn/index.mdx"),
        "---\nmodule: earn\n---\nEarn"
      );
      await fs.writeFile(path.join(content, "unpublished/earn/treasury.mdx"), "Internal Treasury");
      await fs.writeFile(
        path.join(content, "unpublished/earn/meta.json"),
        JSON.stringify({ pages: ["index", "treasury"] })
      );
      await fs.writeFile(
        path.join(content, "unpublished/guides/embedded-yield.mdx"),
        "---\nmodule: earn\n---\nEmbedded Yield"
      );
      for (const [name, value] of [
        ["openapi.json", BASE_DOCUMENT],
        ["api-reference.json", BASE_REFERENCE],
        ["public-surface.json", BASE_SURFACE],
        ["earn-reference-preview.json", previewInput()],
      ] as const)
        await fs.writeFile(path.join(generated, name), JSON.stringify(value));
      await stageEarnDocsPreview(root, PREVIEW);
      assert.deepEqual(
        Object.keys(
          JSON.parse(await fs.readFile(path.join(root, "public/earn/openapi.json"), "utf8")).paths
        ),
        ["/health", OPERATION.path]
      );
      await assert.rejects(fs.access(path.join(content, "docs/earn/treasury.mdx")));
      assert.deepEqual(
        JSON.parse(await fs.readFile(path.join(content, "docs/earn/meta.json"), "utf8")).pages,
        ["index"]
      );
      assert.deepEqual(
        JSON.parse(await fs.readFile(path.join(generated, "public-surface.json"), "utf8")).modules,
        ["custody", "payments", "earn"]
      );
      await resetEarnDocsPreview(root);
      await assert.rejects(fs.access(path.join(root, "public/earn/openapi.json")));
      await assert.rejects(fs.access(path.join(content, "docs/earn")));
      assert.equal(await fs.readFile(path.join(content, "docs/meta.json"), "utf8"), rootMeta);
      assert.equal(
        await fs.readFile(path.join(content, "docs/guides/embedded-yield.mdx"), "utf8"),
        "Previous guide"
      );
      await resetEarnDocsPreview(root);
    } finally {
      await fs.rm(temporary, { recursive: true, force: true });
    }
  });
});
