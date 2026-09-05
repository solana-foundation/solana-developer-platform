import { describe, expect, it } from "vitest";
import { createOpenApiDocument } from "./spec";

interface JsonSchema {
  properties?: Record<string, JsonSchema>;
  required?: string[];
}

function requestSchema(value: unknown): JsonSchema {
  return (value as { content: Record<string, { schema: JsonSchema }> }).content["application/json"]
    .schema;
}

describe("Issuance exact wallet OpenAPI contract", () => {
  it("publishes exact wallet identity on token create and responses", () => {
    const doc = createOpenApiDocument();
    const create = requestSchema(doc.paths?.["/v1/issuance/tokens"]?.post?.requestBody);
    const response = requestSchema(
      doc.paths?.["/v1/issuance/tokens/{tokenId}"]?.get?.responses?.["200"]
    );
    const token = response.properties?.data?.properties?.token;

    expect(create.properties).toHaveProperty("signingCustodyWalletId");
    expect(create.properties).not.toHaveProperty("signingWalletId");
    expect(token?.properties).toHaveProperty("signingCustodyWalletId");
    expect(token?.properties).not.toHaveProperty("signingWalletId");
  });

  it("documents exact action selectors and keeps legacy confirm unchanged", () => {
    const doc = createOpenApiDocument();
    const mint = requestSchema(
      doc.paths?.["/v1/issuance/tokens/{tokenId}/mint"]?.post?.requestBody
    );
    const burn = requestSchema(
      doc.paths?.["/v1/issuance/tokens/{tokenId}/burn"]?.post?.requestBody
    );
    const deploy = requestSchema(
      doc.paths?.["/v1/issuance/tokens/{tokenId}/deploy"]?.post?.requestBody
    );
    const confirm = requestSchema(
      doc.paths?.["/v1/issuance/tokens/{tokenId}/deploy/confirm"]?.post?.requestBody
    );

    expect(mint.properties).toHaveProperty("signingCustodyWalletId");
    expect(mint.properties).not.toHaveProperty("signingWalletId");
    expect(burn.required).toContain("signingCustodyWalletId");
    expect(deploy.properties).toHaveProperty("signingCustodyWalletId");
    expect(confirm.properties).toHaveProperty("signingWalletId");
    expect(confirm.properties).not.toHaveProperty("signingCustodyWalletId");
  });

  it("adds the exact participant-history selector alongside the legacy selector", () => {
    const doc = createOpenApiDocument();
    const parameters = doc.paths?.["/v1/issuance/transactions"]?.get?.parameters ?? [];
    const names = parameters.map((parameter) =>
      "$ref" in parameter ? parameter.$ref : parameter.name
    );

    expect(names).toContain("custodyWalletId");
    expect(names).toContain("walletId");
  });

  it("documents optional selectors for automatic-authority actions and the live list authority read", () => {
    const doc = createOpenApiDocument();
    for (const [method, path] of [
      ["post", "/v1/issuance/tokens/{tokenId}/pause"],
      ["post", "/v1/issuance/tokens/{tokenId}/unpause"],
      ["post", "/v1/issuance/tokens/{tokenId}/allowlist"],
      ["patch", "/v1/issuance/tokens/{tokenId}"],
    ] as const) {
      const schema = requestSchema(doc.paths?.[path]?.[method]?.requestBody);
      expect(schema.properties).toHaveProperty("signingCustodyWalletId");
      expect(schema.required ?? []).not.toContain("signingCustodyWalletId");
    }
    const removal = doc.paths?.["/v1/issuance/tokens/{tokenId}/allowlist/{entryId}"]?.delete;
    expect(removal?.parameters).toContainEqual(
      expect.objectContaining({ name: "signingCustodyWalletId", in: "query", required: false })
    );
    const get = doc.paths?.["/v1/issuance/tokens/{tokenId}"]?.get;
    expect(get?.parameters).toContainEqual(
      expect.objectContaining({ name: "includeAllowlistAuthority", in: "query" })
    );
    expect(requestSchema(get?.responses?.["200"]).properties?.data?.properties).toHaveProperty(
      "allowlistAuthority"
    );
  });

  it("documents conflict responses for wallet-bound mutations", () => {
    const doc = createOpenApiDocument();
    const operations = [
      ["patch", "/v1/issuance/tokens/{tokenId}"],
      ["post", "/v1/issuance/tokens/{tokenId}/deploy"],
      ["post", "/v1/issuance/tokens/{tokenId}/deploy/prepare"],
      ["post", "/v1/issuance/tokens/{tokenId}/deploy/confirm"],
      ["post", "/v1/issuance/tokens/{tokenId}/deploy/prepare-metadata"],
      ["post", "/v1/issuance/tokens/{tokenId}/mint/prepare"],
      ["post", "/v1/issuance/tokens/{tokenId}/mint"],
      ["post", "/v1/issuance/tokens/{tokenId}/burn/prepare"],
      ["post", "/v1/issuance/tokens/{tokenId}/burn"],
      ["post", "/v1/issuance/tokens/{tokenId}/seize/prepare"],
      ["post", "/v1/issuance/tokens/{tokenId}/seize"],
      ["post", "/v1/issuance/tokens/{tokenId}/force-burn/prepare"],
      ["post", "/v1/issuance/tokens/{tokenId}/force-burn"],
      ["post", "/v1/issuance/tokens/{tokenId}/authority/prepare"],
      ["post", "/v1/issuance/tokens/{tokenId}/authority"],
      ["post", "/v1/issuance/tokens/{tokenId}/pause"],
      ["post", "/v1/issuance/tokens/{tokenId}/unpause"],
      ["post", "/v1/issuance/tokens/{tokenId}/freeze"],
      ["post", "/v1/issuance/tokens/{tokenId}/unfreeze"],
      ["post", "/v1/issuance/tokens/{tokenId}/allowlist"],
      ["delete", "/v1/issuance/tokens/{tokenId}/allowlist/{entryId}"],
    ] as const;

    const undocumented = operations
      .filter(([method, path]) => doc.paths?.[path]?.[method]?.responses?.["409"] === undefined)
      .map(([method, path]) => `${method.toUpperCase()} ${path}`);

    expect(undocumented).toEqual([]);
  });
});
