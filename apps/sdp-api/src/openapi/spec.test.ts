import { describe, expect, it } from "vitest";
import { createOpenApiDocument, createPublicOpenApiDocument } from "./spec";

interface TestJsonSchema {
  anyOf?: TestJsonSchema[];
  example?: unknown;
  items?: TestJsonSchema;
  not?: TestJsonSchema;
  oneOf?: TestJsonSchema[];
  properties?: Record<string, TestJsonSchema>;
  required?: string[];
}

function getJsonSchema(value: unknown): TestJsonSchema {
  return (value as { content: Record<string, { schema: TestJsonSchema }> }).content[
    "application/json"
  ].schema;
}

function getWalletResponseSchema(value: unknown): TestJsonSchema {
  return getJsonSchema(value).properties?.data?.properties?.wallet ?? {};
}

function getWalletListItemSchema(value: unknown): TestJsonSchema {
  return getJsonSchema(value).properties?.data?.properties?.wallets?.items ?? {};
}

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

  it("documents private-channel probe deployment addresses as a pair", () => {
    const doc = createOpenApiDocument();
    const probeSchema = getJsonSchema(doc.paths?.["/v1/private-channels/probe"]?.post?.requestBody);

    expect(probeSchema.oneOf).toEqual([
      { required: ["escrowProgramId", "escrowInstanceAddr"] },
      {
        not: {
          anyOf: [{ required: ["escrowProgramId"] }, { required: ["escrowInstanceAddr"] }],
        },
      },
    ]);
  });

  it("publishes the caller-signed money routes and keeps retired button-configuration paths out", () => {
    const internal = createOpenApiDocument();
    const publicDocument = createPublicOpenApiDocument();

    expect(internal.components?.securitySchemes?.clerkBearerAuth).toMatchObject({
      type: "http",
      scheme: "bearer",
      bearerFormat: "JWT",
    });

    // Removed with the UI builder: neither document may resurrect them.
    for (const doc of [internal, publicDocument]) {
      expect(doc.paths?.["/v1/earn/button-configurations/current"]).toBeUndefined();
      expect(doc.paths?.["/v1/earn/button-configurations/public/{publicToken}"]).toBeUndefined();
    }
    expect(publicDocument.components?.securitySchemes?.clerkBearerAuth).toBeUndefined();

    for (const path of [
      "/v1/earn/external-wallet/deposit-transactions",
      "/v1/earn/external-wallet/deposits",
      "/v1/earn/external-wallet/withdrawal-transactions",
      "/v1/earn/external-wallet/withdrawals",
    ]) {
      const publicOperation = publicDocument.paths?.[path]?.post;
      expect(publicOperation?.operationId).toBeDefined();
      expect(publicOperation?.security).toEqual([{ apiKeyAuth: [] }]);

      const internalOperation = internal.paths?.[path]?.post;
      expect(internalOperation?.security).toEqual([
        { apiKeyAuth: [] },
        { clerkBearerAuth: [] },
        { sessionCookie: [] },
      ]);
    }

    const submitRequest = getJsonSchema(
      publicDocument.paths?.["/v1/earn/external-wallet/deposits"]?.post?.requestBody
    );
    const signedTransactionExample = submitRequest.properties?.signedTransaction?.example;
    expect(signedTransactionExample).toEqual(expect.any(String));
    expect(signedTransactionExample).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    expect(Buffer.from(signedTransactionExample as string, "base64").toString("base64")).toBe(
      signedTransactionExample
    );
  });

  it("documents allowlist search/label filters and the labels endpoint", () => {
    const doc = createOpenApiDocument();

    const listPath = doc.paths?.["/v1/issuance/tokens/{tokenId}/allowlist"]?.get;
    const queryParamNames = listPath?.parameters
      ?.filter((parameter) => "in" in parameter && parameter.in === "query")
      .map((parameter) => ("name" in parameter ? parameter.name : undefined));
    expect(queryParamNames).toEqual(expect.arrayContaining(["search", "label"]));

    const labelsPath = doc.paths?.["/v1/issuance/tokens/{tokenId}/allowlist/labels"]?.get;
    expect(labelsPath).toBeDefined();
    expect(labelsPath?.operationId).toBe("listTokenAllowlistLabels");
  });

  it("documents the token list search/filter/sort params and the facets endpoint", () => {
    const doc = createOpenApiDocument();

    const listPath = doc.paths?.["/v1/issuance/tokens"]?.get;
    const queryParamNames = listPath?.parameters
      ?.filter((parameter) => "in" in parameter && parameter.in === "query")
      .map((parameter) => ("name" in parameter ? parameter.name : undefined));
    expect(queryParamNames).toEqual(
      expect.arrayContaining([
        "search",
        "status",
        "deploymentStatus",
        "template",
        "createdAfter",
        "createdBefore",
        "sortBy",
        "sortDirection",
        "page",
        "pageSize",
      ])
    );
    // Invalid query params are rejected, so 400 has to be a documented outcome.
    expect(listPath?.responses?.["400"]).toBeDefined();

    const facetsPath = doc.paths?.["/v1/issuance/tokens/facets"]?.get;
    expect(facetsPath).toBeDefined();
    expect(facetsPath?.operationId).toBe("listTokenFacets");
  });

  it("documents the transaction type filter", () => {
    const doc = createOpenApiDocument();

    const listPath = doc.paths?.["/v1/issuance/tokens/{tokenId}/transactions"]?.get;
    const queryParamNames = listPath?.parameters
      ?.filter((parameter) => "in" in parameter && parameter.in === "query")
      .map((parameter) => ("name" in parameter ? parameter.name : undefined));
    expect(queryParamNames).toEqual(expect.arrayContaining(["type", "status", "page", "pageSize"]));
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

  it("documents exact Connection wallet creation without requiring provider", () => {
    const doc = createOpenApiDocument();
    const operation = doc.paths?.["/v1/wallets"]?.post;
    const requestSchema = getJsonSchema(operation?.requestBody);

    expect(requestSchema.properties?.connectionId).toMatchObject({
      type: "string",
      minLength: 1,
    });
    expect(requestSchema.properties?.connectionId?.example).toBeUndefined();
    expect(requestSchema.required ?? []).not.toContain("connectionId");
    expect(requestSchema.required ?? []).not.toContain("provider");
    expect(requestSchema.example).toEqual({
      provider: "privy",
      label: "Mint authority wallet",
      purpose: "mint_authority",
      setDefault: true,
    });
  });

  it("documents optional exact Connection provisioning for both API-key create routes", () => {
    const doc = createOpenApiDocument();

    for (const path of ["/v1/api-keys", "/v1/projects/{projectId}/api-keys"]) {
      const operation = doc.paths?.[path]?.post;
      const requestSchema = getJsonSchema(operation?.requestBody);

      expect(requestSchema.properties?.connectionId).toBeUndefined();
      expect(JSON.stringify(requestSchema.properties?.provisionWallet)).toContain("connectionId");
      expect(JSON.stringify(requestSchema.properties?.provisionWallet)).toContain("boolean");
      expect(requestSchema.example).toMatchObject({
        provisionWallet: { connectionId: "cconn_123" },
      });
      expect(operation?.responses?.["201"]).toBeDefined();
      expect(operation?.responses?.["400"]).toBeDefined();
      expect(operation?.responses?.["403"]).toBeDefined();
      expect(operation?.responses?.["404"]).toBeDefined();
      expect(operation?.responses?.["409"]).toBeDefined();
      expect(operation?.responses?.["503"]).toBeDefined();
    }
  });

  it("documents exact-one wallet ownership and request-time runtime admission", () => {
    const doc = createOpenApiDocument();
    const createWallet = getWalletResponseSchema(
      doc.paths?.["/v1/wallets"]?.post?.responses?.["201"]
    );
    const listWallet = getWalletListItemSchema(doc.paths?.["/v1/wallets"]?.get?.responses?.["200"]);
    const updateWallet = getWalletResponseSchema(
      doc.paths?.["/v1/wallets/{walletId}"]?.patch?.responses?.["200"]
    );
    const detailWallet = getWalletResponseSchema(
      doc.paths?.["/v1/wallets/{walletId}"]?.get?.responses?.["200"]
    );
    const ownerConstraint = [
      {
        required: ["custodyConfigId"],
        not: { required: ["custodyConnectionId"] },
      },
      {
        required: ["custodyConnectionId"],
        not: { required: ["custodyConfigId"] },
      },
    ];

    for (const walletSchema of [createWallet, listWallet, updateWallet, detailWallet]) {
      expect(walletSchema.properties).toHaveProperty("custodyConfigId");
      expect(walletSchema.properties).toHaveProperty("custodyConnectionId");
      expect(walletSchema.oneOf).toEqual(ownerConstraint);
      expect(walletSchema.required).toContain("isRuntimeExecutionAllowed");
      expect(walletSchema.example).toMatchObject({
        custodyConfigId: "cfg_example",
        isRuntimeExecutionAllowed: true,
        walletId: "privy_wallet_123",
      });
    }

    for (const walletSchema of [createWallet, listWallet, updateWallet]) {
      expect(walletSchema.required ?? []).not.toContain("provider");
    }
    expect(detailWallet.required).toContain("provider");
    expect(detailWallet.required ?? []).not.toContain("balance");
  });

  it("documents Connection-aware wallet resolution failures", () => {
    const doc = createOpenApiDocument();

    expect(doc.paths?.["/v1/wallets"]?.post?.responses).toHaveProperty("404");
    expect(doc.paths?.["/v1/wallets"]?.post?.responses).toHaveProperty("503");
    expect(doc.paths?.["/v1/wallets"]?.get?.responses).toHaveProperty("400");
    expect(doc.paths?.["/v1/wallets"]?.get?.responses).toHaveProperty("409");
    expect(doc.paths?.["/v1/wallets/aggregate"]?.get?.responses).toHaveProperty("400");
    expect(doc.paths?.["/v1/wallets/aggregate"]?.get?.responses).toHaveProperty("409");
    expect(doc.paths?.["/v1/wallets/public-key"]?.get?.responses).toHaveProperty("409");
    expect(doc.paths?.["/v1/wallets/{walletId}"]?.get?.responses).toHaveProperty("409");
    expect(doc.paths?.["/v1/wallets/{walletId}"]?.patch?.responses).toHaveProperty("409");
    expect(doc.paths?.["/v1/payments/wallets/{walletId}/balances"]?.get?.responses).toHaveProperty(
      "409"
    );
  });

  it("documents counterparty ramp requirements", () => {
    const doc = createOpenApiDocument();

    const paths = doc.paths;
    if (paths === undefined) {
      expect.fail("Expected OpenAPI paths");
    }
    const requirementsPathItem = paths["/v1/counterparties/{counterpartyId}/requirements"];
    if (requirementsPathItem === undefined) {
      expect.fail("Expected counterparty requirements path");
    }
    const requirementsPath = requirementsPathItem.get;
    if (requirementsPath === undefined) {
      expect.fail("Expected counterparty requirements GET operation");
    }
    expect(requirementsPath.operationId).toBe("getCounterpartyRequirements");
    const parameters = requirementsPath.parameters;
    if (parameters === undefined) {
      expect.fail("Expected counterparty requirements parameters");
    }
    expect(
      parameters
        .filter((parameter) => "in" in parameter && parameter.in === "query")
        .map((parameter) => ("name" in parameter ? parameter.name : undefined))
    ).toContain("destinationCountry");
    expect(requirementsPath.responses["200"]).toMatchSnapshot();
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
    const updateProject = JSON.stringify(doc.paths?.["/v1/projects/{projectId}"]?.patch);

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
      "Earn",
    ]);

    expect(doc.paths?.["/v1/auth/me"]).toBeUndefined();
    expect(doc.paths?.["/v1/organizations/{orgId}"]).toBeUndefined();
    expect(doc.paths?.["/v1/members"]).toBeUndefined();
    expect(doc.paths?.["/v1/rpc/providers"]).toBeUndefined();
    expect(doc.paths?.["/admin/allowlist"]).toBeUndefined();
    expect(doc.paths?.["/v1/onboarding/status"]).toBeUndefined();
    expect(doc.components?.securitySchemes?.sessionCookie).toBeUndefined();
    expect(doc.components?.securitySchemes?.adminKey).toBeUndefined();
    expect(updateProject).toContain('"rpcProvider"');
    expect(updateProject).toContain('"nodit"');

    expect(doc.paths?.["/health"]?.get).toBeDefined();
    expect(doc.paths?.["/v1/wallets"]?.get).toBeDefined();
    expect(doc.paths?.["/v1/payments/transfers"]?.post).toBeDefined();
    expect(doc.paths?.["/v1/policies"]?.get).toBeDefined();
  });

  it("documents the managed RPC round-robin order", () => {
    const doc = createOpenApiDocument();
    const rpcProviders = JSON.stringify(doc.paths?.["/v1/rpc/providers"]?.get);

    expect(rpcProviders).toContain(
      '"example":["triton","helius","alchemy","quicknode","validationcloud","nodit","default"]'
    );
  });
});
