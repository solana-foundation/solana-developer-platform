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
});
