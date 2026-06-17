import { describe, expect, it } from "vitest";
import { createOpenApiDocument, createPublicOpenApiDocument } from "./spec";

describe("OpenAPI spec", () => {
  it("documents path-based versioning policy", () => {
    const doc = createOpenApiDocument();

    expect(doc.info.version).toBe("0.1.0");
    expect(doc.info.description).toContain("API versioning is path-based");
    expect(doc.info.description).toContain("/v1");
  });

  it("does not document local organization self-registration", () => {
    const doc = createOpenApiDocument();

    expect(doc.components?.securitySchemes?.organizationRegistrationToken).toBeUndefined();
    expect(doc.paths?.["/v1/organizations"]?.post).toBeUndefined();
  });

  it("documents token supply refresh endpoint", () => {
    const doc = createOpenApiDocument();

    const refreshPath = doc.paths?.["/v1/issuance/tokens/{tokenId}/supply/refresh"]?.post;
    expect(refreshPath).toBeDefined();
    expect(refreshPath?.operationId).toBe("refreshTokenSupply");
  });

  it("limits the public document to supported public API families", () => {
    const doc = createPublicOpenApiDocument();

    expect(doc.tags?.map((tag) => tag.name)).toEqual([
      "Health",
      "API Keys",
      "Wallets",
      "Projects",
      "Issuance",
      "Payments",
      "Compliance",
      "Counterparties",
      "Asset Profiles",
    ]);

    expect(doc.paths?.["/v1/auth/me"]).toBeUndefined();
    expect(doc.paths?.["/v1/organizations/{orgId}"]).toBeUndefined();
    expect(doc.paths?.["/v1/members"]).toBeUndefined();
    expect(doc.paths?.["/v1/rpc/providers"]).toBeUndefined();
    expect(doc.paths?.["/admin/allowlist"]).toBeUndefined();
    expect(doc.paths?.["/v1/onboarding/status"]).toBeUndefined();
    expect(doc.components?.securitySchemes?.sessionCookie).toBeUndefined();
    expect(doc.components?.securitySchemes?.adminKey).toBeUndefined();

    expect(doc.paths?.["/health"]?.get).toBeDefined();
    expect(doc.paths?.["/v1/wallets"]?.get).toBeDefined();
    expect(doc.paths?.["/v1/payments/transfers"]?.post).toBeDefined();
  });
});
