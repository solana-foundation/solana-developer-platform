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

function getJsonExamples(value: unknown) {
  return (
    value as {
      content: Record<string, { examples?: Record<string, { value?: unknown }> }>;
    }
  ).content["application/json"].examples;
}

function getWalletResponseSchema(value: unknown): TestJsonSchema {
  return getJsonSchema(value).properties?.data?.properties?.wallet ?? {};
}

function getWalletListItemSchema(value: unknown): TestJsonSchema {
  return getJsonSchema(value).properties?.data?.properties?.wallets?.items ?? {};
}

describe("OpenAPI spec", () => {
  it("documents exact signer-check runtime failures without changing its Provider-ID request", () => {
    const operation = createPublicOpenApiDocument().paths?.["/v1/wallets/signer-check"]?.post;
    expect(operation?.responses).toHaveProperty("403");
    expect(operation?.responses).toHaveProperty("404");
    expect(operation?.responses).toHaveProperty("409");
    const request = getJsonSchema(operation?.requestBody);
    expect(request.properties).toEqual({ walletId: expect.any(Object) });
    expect(request.required).toBeUndefined();
  });

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

    // SECURITY REVIEW GATE (PRO-1872, threat model EARN-027)
    // The public/preview split is a publication boundary. Earn also has a
    // narrower keyless runtime tier, but changing either the operation list or
    // an operation's public security declaration is a threat-model revisit
    // trigger. This list is the route-publication gate: a PR that grows it must
    // carry security sign-off (routes/earn/CLAUDE.md, "Public OpenAPI
    // promotion"). Do not widen the list to make a red test pass.
    const publicEarnOperations = Object.entries(publicDocument.paths ?? {})
      .filter(([path]) => path.startsWith("/v1/earn"))
      .flatMap(([path, item]) =>
        Object.keys(item ?? {})
          .filter((method) => ["get", "post", "put", "patch", "delete"].includes(method))
          .map((method) => `${method.toUpperCase()} ${path}`)
      )
      .sort();
    expect(publicEarnOperations).toEqual(
      [
        "GET /v1/earn/strategies",
        "GET /v1/earn/strategies/{strategyId}",
        "POST /v1/earn/vault-deposit-previews",
        "GET /v1/earn/external-wallet/positions/summary",
        "GET /v1/earn/external-wallet/positions",
        "GET /v1/earn/external-wallet/movements",
        "GET /v1/earn/external-wallet/movements/{movementId}",
        "GET /v1/earn/external-wallet/earnings",
        "POST /v1/earn/external-wallet/deposit-transactions",
        "POST /v1/earn/external-wallet/deposits",
        "POST /v1/earn/external-wallet/withdrawal-previews",
        "POST /v1/earn/external-wallet/withdrawal-transactions",
        "POST /v1/earn/external-wallet/withdrawals",
      ].sort()
    );
    expect(Object.keys(publicDocument.paths["/v1/transactions"])).toEqual(["get"]);
    // Coverage parity across the boundary: every published operation is the
    // same registered route as its internal twin (same operationId), so the
    // app-level request tracing and rate limiting that wrap `/v1/*` apply to
    // both by construction; there is no public-only mount to fall outside them.
    for (const operation of [...publicEarnOperations, "GET /v1/transactions"]) {
      const [method, path] = operation.split(" ") as [string, string];
      const key = method.toLowerCase() as "get" | "post";
      expect(internal.paths?.[path]?.[key]?.operationId).toBe(
        publicDocument.paths?.[path]?.[key]?.operationId
      );
    }

    // Pin the runtime's exact optional-auth boundary in both documents. An
    // empty security requirement means the request may be anonymous; the
    // named alternatives preserve the authenticated behavior of the same
    // handler. Any route moving between these lists is a threat-model revisit.
    const optionalAuthOperations = [
      { method: "get", path: "/v1/earn/strategies" },
      { method: "get", path: "/v1/earn/strategies/{strategyId}" },
      { method: "post", path: "/v1/earn/vault-deposit-previews" },
      { method: "post", path: "/v1/earn/external-wallet/deposit-transactions" },
      { method: "post", path: "/v1/earn/external-wallet/withdrawal-previews" },
      { method: "post", path: "/v1/earn/external-wallet/withdrawal-transactions" },
    ] as const;
    const keyedOnlyOperations = [
      { method: "get", path: "/v1/earn/external-wallet/positions/summary" },
      { method: "get", path: "/v1/earn/external-wallet/positions" },
      { method: "get", path: "/v1/earn/external-wallet/movements" },
      { method: "get", path: "/v1/earn/external-wallet/movements/{movementId}" },
      { method: "get", path: "/v1/earn/external-wallet/earnings" },
      { method: "post", path: "/v1/earn/external-wallet/deposits" },
      { method: "post", path: "/v1/earn/external-wallet/withdrawals" },
    ] as const;

    expect(
      [...optionalAuthOperations, ...keyedOnlyOperations]
        .map(({ method, path }) => `${method.toUpperCase()} ${path}`)
        .sort()
    ).toEqual(publicEarnOperations);

    for (const { method, path } of optionalAuthOperations) {
      const publicOperation = publicDocument.paths?.[path]?.[method];
      expect(publicOperation?.operationId).toBeDefined();
      expect(publicOperation?.security).toEqual([{ apiKeyAuth: [] }, {}]);

      const internalOperation = internal.paths?.[path]?.[method];
      expect(internalOperation?.security).toEqual([
        { apiKeyAuth: [] },
        { clerkBearerAuth: [] },
        { sessionCookie: [] },
        {},
      ]);
    }

    for (const { method, path } of keyedOnlyOperations) {
      expect(publicDocument.paths?.[path]?.[method]?.security).toEqual([{ apiKeyAuth: [] }]);
      expect(internal.paths?.[path]?.[method]?.security).toEqual([
        { apiKeyAuth: [] },
        { clerkBearerAuth: [] },
        { sessionCookie: [] },
      ]);
    }

    const depositPreviewRequest = getJsonSchema(
      publicDocument.paths?.["/v1/earn/vault-deposit-previews"]?.post?.requestBody
    );
    expect(depositPreviewRequest.required).toEqual(
      expect.arrayContaining(["strategyId", "amount"])
    );
    expect(
      JSON.stringify(
        publicDocument.paths?.["/v1/earn/vault-deposit-previews"]?.post?.responses?.["200"]
      )
    ).toContain("sharesOut");

    const withdrawalBuildRequest = getJsonSchema(
      publicDocument.paths?.["/v1/earn/external-wallet/withdrawal-transactions"]?.post?.requestBody
    );
    expect(withdrawalBuildRequest.anyOf).toEqual([
      expect.objectContaining({
        required: expect.arrayContaining(["positionId", "shares"]),
      }),
      expect.objectContaining({
        required: expect.arrayContaining(["strategyId", "ownerAddress", "shares"]),
      }),
    ]);

    expect(
      JSON.stringify(
        publicDocument.paths?.["/v1/earn/external-wallet/positions"]?.get?.responses?.["200"]
      )
    ).toContain('"unlockTimestamp"');

    const anonymousRequestExamples = [
      {
        path: "/v1/earn/external-wallet/deposit-transactions",
        value: {
          strategyId: "earn_strategy_example",
          ownerAddress: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
          amount: "25",
          minSharesOut: "24.9",
        },
      },
      {
        path: "/v1/earn/external-wallet/withdrawal-previews",
        value: {
          strategyId: "earn_strategy_example",
          ownerAddress: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
          shares: "10",
        },
      },
      {
        path: "/v1/earn/external-wallet/withdrawal-transactions",
        value: {
          strategyId: "earn_strategy_example",
          ownerAddress: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
          shares: "10",
          minAmountOut: "24.9",
        },
      },
    ];

    for (const { path, value } of anonymousRequestExamples) {
      const examples = getJsonExamples(publicDocument.paths?.[path]?.post?.requestBody);
      expect(examples?.anonymous?.value).toEqual(value);
      expect(examples?.anonymous?.value).not.toHaveProperty("feePayer");
      expect(examples?.anonymous?.value).not.toHaveProperty("positionId");
    }

    for (const path of [
      "/v1/earn/external-wallet/deposit-transactions",
      "/v1/earn/external-wallet/withdrawal-transactions",
    ]) {
      expect(JSON.stringify(publicDocument.paths?.[path]?.post?.responses?.["200"])).toContain(
        '"sponsored"'
      );
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

  it("documents the 422 SIGNING_REJECTED response on sponsored submit operations", () => {
    const doc = createOpenApiDocument();
    const sponsored = [
      ["/v1/earn/external-wallet/deposits", "post"],
      ["/v1/earn/external-wallet/withdrawals", "post"],
      ["/v1/payments/transfers", "post"],
      ["/v1/issuance/tokens/{tokenId}/mint", "post"],
      ["/v1/dvp/trades/{tradeId}/settle", "post"],
    ] as const;
    for (const [path, method] of sponsored) {
      expect(doc.paths?.[path]?.[method]?.responses, path).toHaveProperty("422");
    }
    const codes = (doc.components?.schemas?.ApiErrorCode ?? doc.components?.schemas?.ErrorCode) as
      | { enum?: string[] }
      | undefined;
    if (codes?.enum) expect(codes.enum).toContain("SIGNING_REJECTED");
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

  it("documents unavailable aggregates instead of partial wallet totals", () => {
    const operation = createOpenApiDocument().paths?.["/v1/wallets/aggregate"]?.get;
    expect(operation?.responses).toHaveProperty("503");
    expect(operation?.description).toContain("rather than returning an incomplete total");
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

  // DvP is documented internally and deliberately withheld from the public
  // document: the swap program is devnet-only and the family is flag-gated off,
  // so every environment a customer can reach answers 403. Publishing it would
  // document an endpoint nobody can call. Promoting it is a product decision.
  it("documents the DvP trade routes on the internal document only", () => {
    const internal = createOpenApiDocument();
    const publicDocument = createPublicOpenApiDocument();

    expect(internal.paths?.["/v1/dvp/trades"]?.post).toBeDefined();
    expect(internal.paths?.["/v1/dvp/trades"]?.get).toBeDefined();
    expect(internal.paths?.["/v1/dvp/trades/{tradeId}"]?.get).toBeDefined();
    expect(internal.components?.schemas?.DvpTrade).toBeDefined();

    expect(Object.keys(publicDocument.paths ?? {}).filter((p) => p.includes("/dvp"))).toEqual([]);
    expect((publicDocument.tags ?? []).map((tag) => tag.name)).not.toContain("DvP");
  });

  // Every 64-bit value on this surface is a string. A JSON number rounds above
  // 2^53, and the nonce is a PDA seed, so a rounded value names an escrow
  // address that does not exist. Documenting one as a number would hand a
  // generated client the bug.
  it("documents DvP u64 fields as strings, never numbers", () => {
    const doc = createOpenApiDocument();
    const trade = doc.components?.schemas?.DvpTrade as {
      properties: Record<string, { type?: string }>;
    };

    for (const field of ["nonce", "expiryTimestamp"]) {
      expect(trade.properties[field]?.type).toBe("string");
    }

    const createBody = JSON.stringify(doc.paths?.["/v1/dvp/trades"]?.post?.requestBody);
    expect(createBody).not.toContain('"type":"number"');
    expect(createBody).not.toContain('"type":"integer"');
  });

  it("documents the managed RPC round-robin order", () => {
    const doc = createOpenApiDocument();
    const rpcProviders = JSON.stringify(doc.paths?.["/v1/rpc/providers"]?.get);

    expect(rpcProviders).toContain(
      '"example":["triton","helius","alchemy","quicknode","validationcloud","nodit","default"]'
    );
  });
});
