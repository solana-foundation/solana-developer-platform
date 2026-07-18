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

  it("documents the wallet metadata fast path and balance-on default", () => {
    const doc = createOpenApiDocument();
    const operation = doc.paths?.["/v1/wallets/{walletId}"]?.get;
    const includeBalance = operation?.parameters?.find(
      (parameter) => "name" in parameter && parameter.name === "includeBalance"
    );

    expect(includeBalance).toMatchObject({
      name: "includeBalance",
      in: "query",
      required: false,
      schema: { type: "string", enum: ["true", "false"] },
    });
    expect(JSON.stringify(includeBalance)).toContain("Defaults to true");
    expect(JSON.stringify(operation?.responses?.["200"])).toContain(
      "Omitted when includeBalance=false"
    );
  });

  it("documents counterparty ramp requirements", () => {
    const doc = createOpenApiDocument();

    const requirementsPath = doc.paths?.["/v1/counterparties/{counterpartyId}/requirements"]?.get;
    expect(requirementsPath).toBeDefined();
    expect(requirementsPath?.operationId).toBe("getCounterpartyRequirements");
    expect(requirementsPath?.responses?.["200"]).toMatchSnapshot();
  });

  it("documents every supported public wallet policy rule kind", () => {
    const doc = createPublicOpenApiDocument();
    const policyPath = doc.paths?.["/v1/payments/wallets/{walletId}/policies"];
    const serializedUpdate = JSON.stringify(policyPath?.put);
    const serializedResponse = JSON.stringify(policyPath?.get?.responses?.["200"]);

    for (const kind of [
      "operation_family",
      "operation_type",
      "asset",
      "destination",
      "amount",
      "approval",
      "always",
    ]) {
      expect(serializedUpdate).toContain(`"${kind}"`);
      expect(serializedResponse).toContain(`"${kind}"`);
    }

    for (const field of ["operationType", "operationTypes", "asset", "assets"]) {
      expect(serializedResponse).toContain(`"${field}"`);
    }
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
      "Policies",
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
    expect(doc.paths?.["/v1/policies"]?.get).toBeDefined();
  });
});
