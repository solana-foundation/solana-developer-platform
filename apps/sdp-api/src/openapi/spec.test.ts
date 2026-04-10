import { describe, expect, it } from "vitest";
import { createOpenApiDocument } from "./spec";

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
});
