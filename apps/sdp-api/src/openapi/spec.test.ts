import { readdirSync, readFileSync } from "node:fs";
import {
  CUSTODY_PROVIDER_CATALOG_BY_ID,
  CUSTODY_PROVIDERS,
  PROVIDER_MODES,
} from "@sdp/types/custody";
import {
  IDEMPOTENCY_REQUIRED_ROUTES,
  INTERNAL_IDEMPOTENCY_REQUIRED_ROUTES,
} from "@sdp/types/idempotency-required-routes";
import { RAMP_ONLY_TRANSFER_STATUSES } from "@sdp/types/payments";
import { COMPLIANCE_PROVIDERS } from "@sdp/types/provider-access";
import { SDP_RELEASE_CHANNEL_NAMES, SDP_RELEASE_CHANNELS } from "@sdp/types/release-channels";
import type {
  OpenAPIObject,
  PathItemObject,
  ReferenceObject,
  ResponseObject,
} from "openapi3-ts/oas30";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ERROR_CODES } from "@/lib/errors";
import { declaredIdempotency, declaredIdempotencyRecovery } from "@/middleware/idempotency";
import {
  ANONYMOUS_MAX_REQUESTS,
  RATE_LIMIT_TIERS,
  RATE_LIMIT_WINDOW_MS,
} from "@/middleware/rate-limit";
import { routeOwnerOf } from "@/routes/route-modules";
import { stableMutatingRouteSteps } from "@/test/helpers/route-owners";
import {
  classifiedValues,
  hiddenValues,
  isValuePublished,
  publishedModules,
} from "./release-channel-values";
import {
  createOpenApiDocument,
  createPublicOpenApiDocument,
  createPublicSurfaceManifest,
} from "./spec";

const forbiddenResponseSchema = z.object({ description: z.string() });

/** The widest public document: every module's routes, as dev serves it. */
const EXPERIMENTAL = { releaseChannel: "experimental" } as const;

interface TestJsonSchema {
  anyOf?: TestJsonSchema[];
  enum?: unknown[];
  example?: unknown;
  items?: TestJsonSchema;
  not?: TestJsonSchema;
  nullable?: boolean;
  oneOf?: TestJsonSchema[];
  properties?: Record<string, TestJsonSchema>;
  required?: string[];
  type?: string;
}

function getJsonSchema(value: unknown): TestJsonSchema {
  return (value as { content: Record<string, { schema: TestJsonSchema }> }).content[
    "application/json"
  ].schema;
}

function getWalletResponseSchema(value: unknown): TestJsonSchema {
  return getJsonSchema(value).properties?.data?.properties?.wallet ?? {};
}

function literalEarnPaths(source: string): string[] {
  return Array.from(new Set(source.match(/\/v1\/earn\/[A-Za-z0-9{}._/-]+/g) ?? []))
    .filter((path) => !path.endsWith("/") && path !== "/v1/earn/external-wallet")
    .sort();
}

function getWalletListItemSchema(value: unknown): TestJsonSchema {
  return getJsonSchema(value).properties?.data?.properties?.wallets?.items ?? {};
}

const OPERATION_METHODS = ["get", "put", "post", "delete", "patch"] as const;

const integrationStatesDocumentSchema = z.object({
  get: z.object({
    responses: z.object({
      200: z.object({
        content: z.object({
          "application/json": z.object({
            schema: z.object({
              properties: z.object({
                data: z.object({
                  properties: z.object({
                    families: z.object({
                      items: z.object({
                        oneOf: z.array(
                          z.object({
                            properties: z.object({
                              integrations: z.object({
                                items: z.object({
                                  properties: z.object({
                                    state: z.object({
                                      oneOf: z.array(
                                        z.object({
                                          properties: z.object({
                                            status: z.object({ enum: z.array(z.string()) }),
                                            modes: z.unknown().optional(),
                                          }),
                                        })
                                      ),
                                    }),
                                  }),
                                }),
                              }),
                            }),
                          })
                        ),
                      }),
                    }),
                  }),
                }),
              }),
            }),
          }),
        }),
      }),
    }),
  }),
});

const errorEnvelopeResponseSchema = z.object({
  content: z.object({
    "application/json": z.object({
      schema: z.object({
        properties: z.object({
          error: z.object({
            properties: z.object({ code: z.object({ enum: z.array(z.string()).optional() }) }),
          }),
        }),
      }),
    }),
  }),
});

/** The codes each operation's error envelope allows, one entry per error response. */
function errorEnvelopeCodes(doc: OpenAPIObject): { status: string; codes: string[] | undefined }[] {
  return Object.values(doc.paths)
    .flatMap((pathItem: PathItemObject) => OPERATION_METHODS.map((method) => pathItem[method]))
    .filter((operation) => operation !== undefined)
    .flatMap((operation) => Object.entries<ResponseObject | ReferenceObject>(operation.responses))
    .flatMap(([status, response]) => {
      const envelope = errorEnvelopeResponseSchema.safeParse(response);
      return envelope.success
        ? [
            {
              status,
              codes:
                envelope.data.content["application/json"].schema.properties.error.properties.code
                  .enum,
            },
          ]
        : [];
    });
}

describe("OpenAPI spec", () => {
  it("requires no project header to leave an organization", () => {
    const doc = createOpenApiDocument();
    for (const [path, method] of [["/v1/members/me", "delete"]] as const) {
      const operation = doc.paths?.[path]?.[method];
      expect(operation).toBeDefined();
      expect(operation?.parameters).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ in: "header", name: "x-project-id" })])
      );
    }
  });

  it("documents API key and Clerk access for shared private-channel operations", () => {
    const doc = createOpenApiDocument();
    for (const [path, method] of [
      ["/v1/private-channels/balance", "get"],
      ["/v1/private-channels/wallets", "get"],
      ["/v1/private-channels/wallets/{walletId}/verify", "post"],
      ["/v1/private-channels/wallets/{pubkey}", "delete"],
    ] as const) {
      expect(doc.paths?.[path]?.[method]?.security).toEqual([
        { apiKeyAuth: [] },
        { clerkBearerAuth: [] },
      ]);
    }
  });

  it("keeps a route's own 403 reasons after its action requirement", () => {
    const forbidden = forbiddenResponseSchema.parse(
      createOpenApiDocument().paths?.["/v1/wallets/initialize"]?.post?.responses?.["403"]
    );
    expect(forbidden.description).toContain("Requires the `wallets.configure` action");
    expect(forbidden.description).toContain("custody_mode_not_allowed");
  });

  it("gives a route without its own 403 reasons the action requirement alone", () => {
    const forbidden = forbiddenResponseSchema.parse(
      createOpenApiDocument().paths?.["/v1/payments/transfers"]?.get?.responses?.["403"]
    );
    expect(forbidden.description).toMatch(/^Forbidden\. Requires the `transfers\.read` action/);
    expect(forbidden.description).not.toContain("\n\nError");
  });

  // Keys are credentials, not administrators (HOO-2099): key, member, project
  // member and organization administration answer a signed-in person only.
  it("documents administration as Clerk-session only and keeps it out of the public document", () => {
    const doc = createOpenApiDocument();
    const publicDocument = createPublicOpenApiDocument(EXPERIMENTAL);
    for (const [path, method] of [
      ["/v1/api-keys", "get"],
      ["/v1/api-keys", "post"],
      ["/v1/api-keys/{keyId}", "get"],
      ["/v1/api-keys/{keyId}", "patch"],
      ["/v1/api-keys/{keyId}", "delete"],
      ["/v1/api-keys/{keyId}/rotate", "post"],
      ["/v1/projects/{projectId}/api-keys", "get"],
      ["/v1/projects/{projectId}/api-keys", "post"],
      ["/v1/projects/{projectId}/members", "get"],
      ["/v1/members", "get"],
      ["/v1/members/me", "get"],
      ["/v1/members/me", "delete"],
      ["/v1/members/invite", "post"],
      ["/v1/members/invitations/{invitationId}", "delete"],
      ["/v1/members/{memberId}", "patch"],
      ["/v1/members/{memberId}", "delete"],
      ["/v1/organizations/{orgId}", "patch"],
      ["/v1/organizations", "post"],
    ] as const) {
      expect(doc.paths?.[path]?.[method]?.security, `${method} ${path}`).toEqual([
        { clerkBearerAuth: [] },
      ]);
      expect(publicDocument.paths?.[path]?.[method], `${method} ${path}`).toBeUndefined();
    }
  });

  it("documents exact signer-check runtime failures and requires its Provider-ID request", () => {
    const operation = createPublicOpenApiDocument({ releaseChannel: "stable" }).paths?.[
      "/v1/wallets/signer-check"
    ]?.post;
    expect(operation?.responses).toHaveProperty("403");
    expect(operation?.responses).toHaveProperty("404");
    expect(operation?.responses).toHaveProperty("409");
    const request = getJsonSchema(operation?.requestBody);
    expect(request.properties).toEqual({ walletId: expect.any(Object) });
    // A wallet scope has no default signing wallet, so the request names one.
    expect(request.required).toEqual(["walletId"]);
  });

  it("documents path-based versioning policy", () => {
    const doc = createOpenApiDocument();

    expect(doc.info.version).toBe("0.1.0");
    expect(doc.info.description).toContain("API versioning is path-based");
    expect(doc.info.description).toContain("/v1");
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

  it.each([
    ["experimental", true],
    ["beta", true],
    ["stable", false],
  ] as const)(
    "%s publishes Earn only when its release channel runs it",
    (releaseChannel, runsEarn) => {
      const document = createPublicOpenApiDocument({ releaseChannel });
      const operations = Object.entries(document.paths)
        .filter(([path]) => path.startsWith("/v1/earn/"))
        .flatMap(([, item]) =>
          (["get", "post", "put", "patch", "delete"] as const).filter(
            (method) => item[method] !== undefined
          )
        );
      const manifest = createPublicSurfaceManifest(releaseChannel);

      expect(operations.length).toBe(runsEarn ? 36 : 0);
      expect(document.tags?.some((tag) => tag.name === "Earn")).toBe(runsEarn);
      expect(/earn/i.test(JSON.stringify(document))).toBe(runsEarn);
      expect(manifest.modules.includes("earn")).toBe(runsEarn);
      expect(manifest.grantableActions.some(({ module }) => module === "earn")).toBe(runsEarn);
    }
  );

  it("publishes the Embedded Yield and Treasury routes and keeps internal and retired paths out", () => {
    const internal = createOpenApiDocument();
    const publicDocument = createPublicOpenApiDocument(EXPERIMENTAL);

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
    // The public/internal split is a publication boundary. Changing either the
    // operation list or an operation's public security declaration is a
    // threat-model revisit trigger. This list is the route-publication gate: a PR that grows it must
    // carry security sign-off (routes/earn/CLAUDE.md, "Public OpenAPI
    // promotion"). Do not widen the list to make a red test pass.
    //
    // Two kinds of money route are published. The `external-wallet` routes are caller-signed:
    // SDP holds no key. The `vault-*` routes are Treasury: SDP signs from the organization's
    // custody wallet, so the key's wallet scope bounds them at the signer. Programs, provider
    // actions, onboarding and the share reconciliation report stay internal.
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
        "POST /v1/earn/external-wallet/withdrawal-options",
        "POST /v1/earn/external-wallet/queued-withdrawal-previews",
        "POST /v1/earn/external-wallet/withdrawal-request-transactions",
        "POST /v1/earn/external-wallet/withdrawal-requests",
        "GET /v1/earn/external-wallet/withdrawal-requests",
        "GET /v1/earn/external-wallet/withdrawal-requests/{withdrawalRequestId}",
        "POST /v1/earn/external-wallet/withdrawal-request-cancel-transactions",
        "POST /v1/earn/external-wallet/withdrawal-request-cancellations",
        "GET /v1/earn/movements",
        "POST /v1/earn/vault-deposits",
        "GET /v1/earn/vault-deposits",
        "GET /v1/earn/vault-deposits/{movementId}",
        "GET /v1/earn/vault-positions",
        "POST /v1/earn/vault-withdrawals",
        "GET /v1/earn/vault-withdrawals",
        "GET /v1/earn/vault-withdrawals/{movementId}",
        "POST /v1/earn/vault-withdrawal-previews",
        "POST /v1/earn/vault-withdrawal-options",
        "POST /v1/earn/vault-queued-withdrawal-previews",
        "POST /v1/earn/vault-withdrawal-requests",
        "GET /v1/earn/vault-withdrawal-requests",
        "GET /v1/earn/vault-withdrawal-requests/{withdrawalRequestId}",
        "POST /v1/earn/vault-withdrawal-requests/{withdrawalRequestId}/cancel",
      ].sort()
    );
    // Named so a regression reads as what it is: none of these families is ever public.
    for (const internalOnly of [
      "/v1/earn/programs",
      "/v1/earn/provider-actions",
      "/v1/earn/onboarding",
      "/v1/earn/vault-share-reconciliation",
    ]) {
      expect(
        publicEarnOperations.filter((operation) =>
          operation.split(" ")[1]?.startsWith(internalOnly)
        )
      ).toEqual([]);
      expect(Object.keys(internal.paths).some((path) => path.startsWith(internalOnly))).toBe(true);
    }
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

    // Every Earn operation requires a credential in both documents: no empty
    // security requirement, so no request may be anonymous.
    for (const [path, item] of Object.entries(publicDocument.paths ?? {})) {
      if (!path.startsWith("/v1/earn")) continue;
      for (const method of ["get", "post", "put", "patch", "delete"] as const) {
        const operation = item[method];
        if (!operation) continue;
        expect(operation.security, `${method} ${path}`).toEqual([{ apiKeyAuth: [] }]);
        expect(internal.paths?.[path]?.[method]?.security, `${method} ${path}`).toEqual([
          { apiKeyAuth: [] },
          { clerkBearerAuth: [] },
        ]);
      }
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
    expect(withdrawalBuildRequest.required).toEqual(
      expect.arrayContaining(["positionId", "shares"])
    );
    expect(withdrawalBuildRequest.properties).not.toHaveProperty("strategyId");
    expect(withdrawalBuildRequest.properties?.redemptionMode?.enum).toEqual([
      "standard",
      "instant",
    ]);

    expect(
      JSON.stringify(
        publicDocument.paths?.["/v1/earn/external-wallet/positions"]?.get?.responses?.["200"]
      )
    ).toContain('"unlockTimestamp"');

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

  it("keeps literal Earn guide endpoints aligned with their documented scopes", () => {
    const publicDocument = createPublicOpenApiDocument(EXPERIMENTAL);
    const internalDocument = createOpenApiDocument();
    const guide = readFileSync(
      new URL("../../../sdp-docs/content/docs/guides/embedded-yield.mdx", import.meta.url),
      "utf8"
    );
    const generatedModule = readFileSync(
      new URL(
        "../../../sdp-web/src/app/(session)/dashboard/[projectId]/markets/earn/earn-integration-snippets.ts",
        import.meta.url
      ),
      "utf8"
    );
    const guideDirectory = new URL("../../../sdp-docs/content/docs/earn/", import.meta.url);
    const guides = readdirSync(guideDirectory, { recursive: true, encoding: "utf8" })
      .filter((file) => file.endsWith(".mdx"))
      .map((file) => readFileSync(new URL(file, guideDirectory), "utf8"))
      .join("\n");
    const partnerPaths = literalEarnPaths(`${guide}\n${guides}\n${generatedModule}`);
    expect(partnerPaths).toEqual(
      expect.arrayContaining([
        "/v1/earn/external-wallet/withdrawal-options",
        "/v1/earn/external-wallet/queued-withdrawal-previews",
        "/v1/earn/external-wallet/withdrawal-request-transactions",
        "/v1/earn/external-wallet/withdrawal-requests",
        "/v1/earn/external-wallet/withdrawal-requests/{withdrawalRequestId}",
        "/v1/earn/external-wallet/withdrawal-request-cancel-transactions",
        "/v1/earn/external-wallet/withdrawal-request-cancellations",
      ])
    );
    for (const path of partnerPaths) {
      expect(publicDocument.paths?.[path], `Missing public OpenAPI path: ${path}`).toBeDefined();
    }
    const draftDirectory = new URL("../../../sdp-docs/content/unpublished/earn/", import.meta.url);
    const drafts = readdirSync(draftDirectory, { recursive: true, encoding: "utf8" })
      .filter((file) => file.endsWith(".mdx"))
      .map((file) => readFileSync(new URL(file, draftDirectory), "utf8"))
      .join("\n");
    const draftPaths = literalEarnPaths(drafts);
    expect(draftPaths.length).toBeGreaterThan(0);
    for (const path of draftPaths) {
      expect(
        internalDocument.paths?.[path],
        `Missing internal OpenAPI path: ${path}`
      ).toBeDefined();
    }
  });

  it("publishes both asynchronous withdrawal mechanisms with their exact row shapes", () => {
    const doc = createPublicOpenApiDocument(EXPERIMENTAL);
    const requestPath = doc.paths?.["/v1/earn/external-wallet/withdrawal-request-transactions"];

    const buildRequest = getJsonSchema(requestPath?.post?.requestBody);
    expect(buildRequest.anyOf).toHaveLength(3);
    const operatorRequests =
      buildRequest.anyOf?.filter((variant) =>
        variant.properties?.mechanism?.enum?.includes("operatorRedemption")
      ) ?? [];
    expect(operatorRequests).toHaveLength(2);
    const operatorRequest = operatorRequests.find((variant) => variant.properties?.shares);
    expect(operatorRequest?.required).toEqual(
      expect.arrayContaining(["positionId", "shares", "mechanism"])
    );
    // A par request over held intermediate names its amount instead of shares.
    const intermediateRequest = operatorRequests.find(
      (variant) => variant.properties?.intermediateAmount
    );
    expect(intermediateRequest?.required).toEqual(
      expect.arrayContaining(["positionId", "intermediateAmount", "mechanism"])
    );
    expect(intermediateRequest?.properties).not.toHaveProperty("shares");
    for (const variant of operatorRequests) {
      expect(variant.properties).not.toHaveProperty("strategyId");
      expect(variant.properties).not.toHaveProperty("discountBps");
      expect(variant.properties).not.toHaveProperty("deadlineSeconds");
    }

    const options = getJsonSchema(
      doc.paths?.["/v1/earn/external-wallet/withdrawal-options"]?.post?.responses?.["200"]
    );
    expect(options.properties?.data?.properties?.parRedemption).toMatchObject({
      nullable: true,
      required: expect.arrayContaining([
        "intermediateMint",
        "assetMint",
        "minimumShares",
        "minimumIntermediateAmount",
        "cancelable",
        "operatorSettled",
      ]),
    });

    const preview = getJsonSchema(
      doc.paths?.["/v1/earn/external-wallet/queued-withdrawal-previews"]?.post?.responses?.["200"]
    );
    const operatorPreview = preview.properties?.data?.anyOf?.find((variant) =>
      variant.properties?.mechanism?.enum?.includes("operatorRedemption")
    );
    expect(operatorPreview?.required).toEqual(
      expect.arrayContaining(["mechanism", "intermediateMint", "intermediateAmount", "assets"])
    );

    const record = getJsonSchema(
      doc.paths?.["/v1/earn/external-wallet/withdrawal-requests/{withdrawalRequestId}"]?.get
        ?.responses?.["200"]
    );
    const recordVariants = record.properties?.data?.properties?.withdrawalRequest?.anyOf ?? [];
    expect(recordVariants).toHaveLength(2);
    const operatorRecord = recordVariants.find((variant) =>
      variant.properties?.mechanism?.enum?.includes("operatorRedemption")
    );
    expect(operatorRecord?.properties?.intermediateMint?.type).toBe("string");
    expect(operatorRecord?.properties?.intermediateAmount?.type).toBe("string");
    expect(operatorRecord?.properties?.discountBps?.nullable).toBe(true);
    expect(operatorRecord?.properties?.maturityTimestamp?.nullable).toBe(true);
    expect(operatorRecord?.properties?.deadlineTimestamp?.nullable).toBe(true);

    const buildResponse = getJsonSchema(requestPath?.post?.responses?.["200"]);
    const buildVariants = buildResponse.properties?.data?.properties?.transaction?.anyOf ?? [];
    const operatorBuild = buildVariants.find(
      (variant) =>
        variant.properties?.action?.enum?.includes("request") &&
        variant.properties?.mechanism?.enum?.includes("operatorRedemption")
    );
    expect(operatorBuild?.required).toEqual(
      expect.arrayContaining(["mechanism", "intermediateMint", "intermediateAmount"])
    );
    expect(operatorBuild?.properties).not.toHaveProperty("discountBps");
    expect(operatorBuild?.properties).not.toHaveProperty("maturityTimestamp");
    expect(operatorBuild?.properties).not.toHaveProperty("deadlineTimestamp");
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

  it("documents wallet creation as exactly one owner: provider or connectionId", () => {
    const doc = createOpenApiDocument();
    const operation = doc.paths?.["/v1/wallets"]?.post;
    const requestSchema = getJsonSchema(operation?.requestBody);

    expect(
      requestSchema.anyOf?.map((variant) => ({ required: variant.required, not: variant.not }))
    ).toEqual([
      { required: ["provider"], not: { required: ["connectionId"] } },
      { required: ["connectionId"], not: { required: ["provider"] } },
    ]);
    expect(requestSchema.anyOf?.[1]?.properties?.connectionId).toMatchObject({
      type: "string",
      minLength: 1,
    });
    expect(requestSchema.properties).toBeUndefined();
    expect(requestSchema.example).toEqual({
      provider: "privy",
      label: "Treasury wallet",
      purpose: "transfer",
    });
  });

  it("documents no wallet provisioning on either API-key create route", () => {
    const doc = createOpenApiDocument();

    for (const path of ["/v1/api-keys", "/v1/projects/{projectId}/api-keys"]) {
      const operation = doc.paths?.[path]?.post;
      const requestSchema = getJsonSchema(operation?.requestBody);

      // Creating a key never creates a wallet (HOO-2099).
      for (const field of ["connectionId", "provisionWallet", "walletLabel", "walletPurpose"]) {
        expect(requestSchema.properties?.[field], `${path} ${field}`).toBeUndefined();
      }
      expect(requestSchema.example).toMatchObject({ walletIds: ["cwlt_0f2c8c1e"] });
      expect(operation?.responses?.["201"]).toBeDefined();
      expect(operation?.responses?.["400"]).toBeDefined();
    }
  });

  it("documents the 422 SIGNING_REJECTED response on sponsored submit operations", () => {
    const doc = createOpenApiDocument();
    // Earn's external-wallet submits are absent on purpose: no paymaster co-signs
    // them (the customer's wallet or the caller's own fee payer signs), so they
    // cannot answer SIGNING_REJECTED until SDP sponsors them (PRO-1744).
    const sponsored = [
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
        description: "Owned by a Managed config.",
        required: ["custodyConfigId"],
        not: { required: ["custodyConnectionId"] },
      },
      {
        description: "Owned by a Custody Connection.",
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
    expect(doc.paths?.["/v1/wallets/{walletId}"]?.get?.responses).toHaveProperty("503");
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
    ).toEqual(["provider", "direction", "assetRail", "fiatCurrency", "destinationCustodyWalletId"]);
    expect(requirementsPath.responses["200"]).toMatchSnapshot();
  });

  it("documents no wallet policy, approval or policy-profile endpoints (ADR 0006)", () => {
    for (const doc of [createOpenApiDocument(), createPublicOpenApiDocument(EXPERIMENTAL)]) {
      const paths = Object.keys(doc.paths ?? {});
      expect(paths.filter((path) => /polic|approval-requests/.test(path))).toEqual([]);
      expect(doc.tags?.map((tag) => tag.name)).not.toContain("Policies");
      expect(JSON.stringify(doc)).not.toContain("SIGNING_PENDING");
    }
  });

  it("limits the public document to supported public API families", () => {
    const doc = createPublicOpenApiDocument(EXPERIMENTAL);

    expect(doc.tags?.map((tag) => tag.name)).toEqual([
      "Health",
      "Wallets",
      "Projects",
      "Issuance",
      "Payments",
      "Compliance",
      "Counterparties",
      "Asset Profiles",
      "Earn",
    ]);

    expect(doc.paths?.["/v1/organizations/{orgId}"]).toBeUndefined();
    expect(doc.paths?.["/v1/members"]).toBeUndefined();
    expect(doc.paths?.["/admin/allowlist"]).toBeUndefined();
    expect(doc.paths?.["/v1/onboarding/status"]).toBeUndefined();
    expect(doc.components?.securitySchemes?.adminKey).toBeUndefined();

    expect(doc.paths?.["/health"]?.get).toBeDefined();
    expect(doc.paths?.["/v1/wallets"]?.get).toBeDefined();
    expect(doc.paths?.["/v1/payments/transfers"]?.post).toBeDefined();
  });

  // A deployment refuses every module outside its release channel with 403, so
  // the document it publishes must not list those routes.
  for (const releaseChannel of SDP_RELEASE_CHANNEL_NAMES) {
    it(`${releaseChannel}: publishes no path whose module is outside the release channel`, () => {
      const modules: readonly string[] = SDP_RELEASE_CHANNELS[releaseChannel];
      const outside = Object.keys(createPublicOpenApiDocument({ releaseChannel }).paths ?? {})
        .map((path) => [path, routeOwnerOf(path)] as const)
        .filter(
          ([, owner]) => owner === undefined || (owner !== "core" && !modules.includes(owner))
        )
        .map(([path, owner]) => `${owner} ${path}`);
      expect(outside).toEqual([]);
    });
  }

  // Shared schemas name module values too (an API key's `earn:write` scope, a
  // `moonpay` transfer provider). No document may name a value its channel leaves out.
  for (const releaseChannel of SDP_RELEASE_CHANNEL_NAMES) {
    it(`${releaseChannel}: names no enum value, example or default its release channel leaves out`, () => {
      const modules = publishedModules(releaseChannel);
      const leaked = new Set<string>();
      const visit = (node: unknown, inValues: boolean): void => {
        if (typeof node === "string") {
          if (inValues && !isValuePublished(node, modules, releaseChannel)) leaked.add(node);
          return;
        }
        if (Array.isArray(node)) {
          for (const entry of node) visit(entry, inValues);
          return;
        }
        if (node && typeof node === "object") {
          for (const [key, value] of Object.entries(node)) {
            visit(value, inValues || ["enum", "example", "examples", "default"].includes(key));
          }
        }
      };
      visit(createPublicOpenApiDocument({ releaseChannel }), false);
      expect([...leaked]).toEqual([]);
    });
  }

  // Common envelopes carry every AppError code; Earn's 501 narrows to NOT_IMPLEMENTED.
  it("lists every ErrorCode in common envelopes and NOT_IMPLEMENTED for Earn 501s", () => {
    const documents = [
      createOpenApiDocument(),
      ...SDP_RELEASE_CHANNEL_NAMES.map((releaseChannel) =>
        createPublicOpenApiDocument({ releaseChannel })
      ),
    ];
    for (const doc of documents) {
      const lists = errorEnvelopeCodes(doc);
      expect(lists.length).toBeGreaterThan(0);
      for (const { status, codes } of lists) {
        if (status === "501") expect(codes).toEqual(["NOT_IMPLEMENTED"]);
        else expect(codes).toEqual(ERROR_CODES);
      }
    }
  });

  it.each(["stable", "beta"] as const)(
    "%s hides ramp-only transfer fields and prose",
    (releaseChannel) => {
      const doc = createPublicOpenApiDocument({ releaseChannel });
      const request = getJsonSchema(doc.paths?.["/v1/payments/transfers"]?.post?.requestBody);
      expect(request.properties).not.toHaveProperty("transferId");
      expect(request.properties).toHaveProperty("counterpartyAccountId");
      // All shared transfer responses, including batches, retry and recurring collect.
      const serializedPayments = JSON.stringify(
        Object.fromEntries(
          Object.entries(doc.paths).filter(([path]) => path.startsWith("/v1/payments/"))
        )
      );
      const serialized = JSON.stringify(doc);
      for (const field of [
        "deliveryMode",
        "fiatCurrency",
        "fiatAmount",
        "fiatPayout",
        "providerReference",
        "deliveryMismatch",
        "rampsMemo",
      ]) {
        expect(serializedPayments).not.toContain(`"${field}"`);
      }
      expect(serialized).not.toMatch(/\bramps?\b|onramp\.read|offramp\.read/i);
      const parameters = doc.paths?.["/v1/payments/transfers"]?.get?.parameters;
      expect(parameters).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ name: "providerReference" })])
      );
      const transfer = getJsonSchema(
        doc.paths?.["/v1/payments/transfers/{transferId}"]?.get?.responses?.["200"]
      ).properties?.data?.properties?.transfer;
      expect(transfer).toBeDefined();
      for (const status of RAMP_ONLY_TRANSFER_STATUSES) {
        expect(JSON.stringify(transfer)).not.toContain(`"${status}"`);
      }
      // Payment requests own these statuses independently of Ramps.
      const paymentRequest = JSON.stringify(
        doc.paths?.["/v1/payments/requests/{paymentRequestId}/cancel"]
      );
      expect(paymentRequest).toContain("awaiting_payment");
      expect(serialized).not.toContain("x-sdp-module");
      expect(serialized).not.toContain("x-sdp-description-without-module");
    }
  );

  it("keeps the ramp transfer contract in experimental and internal documents", () => {
    for (const doc of [createPublicOpenApiDocument(EXPERIMENTAL), createOpenApiDocument()]) {
      expect(
        getJsonSchema(doc.paths?.["/v1/payments/transfers"]?.post?.requestBody).properties
      ).toHaveProperty("transferId");
      expect(JSON.stringify(doc)).toContain('"deliveryMode"');
      expect(JSON.stringify(doc)).toContain('"settling"');
      expect(doc.paths?.["/v1/transactions"]?.get?.description).toContain(
        "`onramp.read` or `offramp.read` for a ramp transfer"
      );
    }
  });

  // A custody provider publishes where the channel offers it in either mode, and
  // local signing (self-hosted only) never does. Pinned so a promotion is a visible change.
  it("names only Privy as a custody provider on stable, every one but local on experimental", () => {
    const stable = createPublicOpenApiDocument({ releaseChannel: "stable" });
    const serialized = JSON.stringify(stable);
    expect(CUSTODY_PROVIDERS.filter((provider) => serialized.includes(`"${provider}"`))).toEqual([
      "privy",
    ]);
    // Prose too: no description names a provider stable does not offer.
    const unpublishedLabels = CUSTODY_PROVIDERS.filter((provider) => provider !== "privy").map(
      (provider) => CUSTODY_PROVIDER_CATALOG_BY_ID[provider].label
    );
    expect(unpublishedLabels.filter((label) => serialized.includes(label))).toEqual([]);
    expect(serialized).not.toMatch(/fireblocks|coinbase/i);
    expect(createPublicSurfaceManifest("stable").custodyProviders).toEqual(["privy"]);

    const paths = stable.paths;
    expect(paths).toBeDefined();
    const createBody = getJsonSchema(paths?.["/v1/wallets"]?.post?.requestBody);
    const managedOwner = z
      .object({ properties: z.object({ provider: z.object({ enum: z.array(z.string()) }) }) })
      .parse(z.object({ anyOf: z.array(z.unknown()) }).parse(createBody).anyOf[0]);
    expect(managedOwner.properties.provider.enum).toEqual(["privy"]);
    // Session-only (wallets.configure), so no channel publishes it.
    expect(paths?.["/v1/wallets/initialize"]).toBeUndefined();
    expect(createOpenApiDocument().paths?.["/v1/wallets/initialize"]?.post?.security).toEqual([
      { clerkBearerAuth: [] },
    ]);

    for (const releaseChannel of SDP_RELEASE_CHANNEL_NAMES) {
      expect(JSON.stringify(createPublicOpenApiDocument({ releaseChannel }))).not.toContain(
        '"local"'
      );
    }
    expect(JSON.stringify(createOpenApiDocument())).toContain('"local"');

    const experimentalCreate = getJsonSchema(
      createPublicOpenApiDocument(EXPERIMENTAL).paths?.["/v1/wallets"]?.post?.requestBody
    );
    expect(JSON.stringify(experimentalCreate)).toContain(
      JSON.stringify(CUSTODY_PROVIDERS.filter((provider) => provider !== "local"))
    );
  });

  it("publishes every family's not configured modes as one or more, with no upper bound", () => {
    const document = createPublicOpenApiDocument(EXPERIMENTAL);
    const families = integrationStatesDocumentSchema.parse(document.paths["/v1/integrations"]).get
      .responses[200].content["application/json"].schema.properties.data.properties.families.items
      .oneOf;
    const notConfiguredModes = families
      .flatMap((family) => family.properties.integrations.items.properties.state.oneOf)
      .filter((state) => state.properties.status.enum.includes("not_configured"))
      .map((state) => state.properties.modes);
    const oneOrMoreModes = {
      type: "array",
      items: { type: "string", enum: [...PROVIDER_MODES] },
      minItems: 1,
    };

    expect(notConfiguredModes).toEqual(families.map(() => oneOrMoreModes));
  });

  it("drops a custody provider's own transfer fields where the channel does not publish it", () => {
    const transfer = (releaseChannel: "stable" | "experimental") =>
      JSON.stringify(
        getJsonSchema(
          createPublicOpenApiDocument({ releaseChannel }).paths?.[
            "/v1/payments/transfers/{transferId}"
          ]?.get?.responses?.["200"]
        )
      );
    expect(transfer("stable")).not.toMatch(/fireblocks/i);
    expect(transfer("experimental")).toContain('"fireblocks"');
    expect(transfer("experimental")).not.toContain("x-sdp-custody-provider");
  });

  // Provider availability lists every family in one response, so a channel
  // without Compliance must name neither the family nor its providers there,
  // in values or prose; the runtime response omits those entries to match.
  for (const releaseChannel of SDP_RELEASE_CHANNEL_NAMES) {
    it(`${releaseChannel}: names Compliance in provider availability only when the channel runs it`, () => {
      const operation = createPublicOpenApiDocument({ releaseChannel }).paths?.[
        "/v1/projects/{projectId}/provider-availability"
      ]?.get;
      expect(operation).toBeDefined();
      const published = JSON.stringify(operation);
      const runsCompliance = SDP_RELEASE_CHANNELS[releaseChannel].includes("compliance");
      const complianceValues = ["compliance", ...COMPLIANCE_PROVIDERS];

      expect(complianceValues.filter((value) => published.includes(`"${value}"`))).toEqual(
        runsCompliance ? complianceValues : []
      );
      expect(/compliance/i.test(published)).toBe(runsCompliance);
    });
  }

  // A deployment stores values a narrower channel no longer documents (a key
  // saved with `tokens:read` before a downgrade, or created on another
  // channel's dashboard). Response enums therefore open up rather than narrow,
  // so stored records still validate, while request enums list what it accepts.
  it("narrows request enums and opens response enums that lose values", () => {
    const doc = createPublicOpenApiDocument({ releaseChannel: "stable" });
    const create = JSON.stringify(getJsonSchema(doc.paths?.["/v1/wallets"]?.post?.requestBody));
    expect(create).toContain('"fee_payer"');
    expect(create).not.toContain('"mint_authority"');

    const read = JSON.stringify(
      getJsonSchema(doc.paths?.["/v1/wallets/{walletId}"]?.get?.responses?.["200"])
    );
    expect(read).toContain('"purpose"');
    expect(read).not.toContain('"mint_authority"');
    expect(read).not.toContain('"fee_payer"');
  });

  it("names the hidden families' actions in no channel's document or surface manifest", () => {
    expect([...hiddenValues()].sort()).toEqual([
      "feedback.execute",
      "organizations.manage",
      "organizations.read",
    ]);
    for (const releaseChannel of SDP_RELEASE_CHANNEL_NAMES) {
      const published = JSON.stringify(createPublicOpenApiDocument({ releaseChannel }));
      const manifest = createPublicSurfaceManifest(releaseChannel);
      for (const value of hiddenValues()) {
        expect(published).not.toContain(`"${value}"`);
      }
      expect(manifest.grantableActions.map(({ module }) => module)).not.toContain("organizations");
    }
  });

  it("gives the docs the rate limits the API enforces, the same on every channel", () => {
    for (const releaseChannel of SDP_RELEASE_CHANNEL_NAMES) {
      expect(createPublicSurfaceManifest(releaseChannel).rateLimits).toEqual({
        windowSeconds: RATE_LIMIT_WINDOW_MS / 1000,
        apiKeyTiers: RATE_LIMIT_TIERS,
        unauthenticatedPerIp: ANONYMOUS_MAX_REQUESTS,
      });
    }
  });

  it("keeps the values of modules a channel runs", () => {
    const stable = JSON.stringify(createPublicOpenApiDocument({ releaseChannel: "stable" }));
    expect(stable).toContain('"fee_payer"');
    const experimental = JSON.stringify(createPublicOpenApiDocument(EXPERIMENTAL));
    for (const value of ["mint_authority", "moonpay"]) {
      expect(experimental).toContain(`"${value}"`);
    }
    expect(classifiedValues()).toContain("earn.execute");
  });

  it("documents only the stable modules for production", () => {
    const stable = createPublicOpenApiDocument({ releaseChannel: "stable" });
    expect(stable.tags?.map((tag) => tag.name)).toEqual([
      "Health",
      "Wallets",
      "Projects",
      "Payments",
      "Counterparties",
    ]);
    expect(stable.paths?.["/v1/payments/recurring-payments"]?.post).toBeDefined();
    expect(stable.paths?.["/v1/payments/ramps/onramp/quote"]).toBeUndefined();
    expect(stable.paths?.["/v1/counterparties/{counterpartyId}/requirements"]).toBeUndefined();
    expect(stable.paths?.["/v1/issuance/tokens"]).toBeUndefined();
  });

  it("documents the DvP trade routes on the internal document only", () => {
    const internal = createOpenApiDocument();
    const publicDocument = createPublicOpenApiDocument(EXPERIMENTAL);

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
});

/**
 * The documented `Idempotency-Key` header follows each route's declared
 * `idempotent()` mode (ADR 0009), so the reference cannot drift from the code:
 * required where the chain requires it, optional where it accepts it, and
 * absent on every other mutating route of a `stable` module.
 */
const MUTATING_OPERATION_KEYS = {
  DELETE: "delete",
  PATCH: "patch",
  POST: "post",
  PUT: "put",
} as const satisfies Record<string, string>;

/** A `"METHOD /path"` route key, split into its method and path. */
const mutatingRouteSchema = z.tuple([
  z.enum(["DELETE", "PATCH", "POST", "PUT"]),
  z.string().startsWith("/"),
]);

/** The OpenAPI operation a `"METHOD /path"` route key names, if the document has one. */
function operationFor(document: ReturnType<typeof createOpenApiDocument>, route: string) {
  const [method, path] = mutatingRouteSchema.parse(route.split(" "));
  return document.paths?.[path]?.[MUTATING_OPERATION_KEYS[method]];
}

describe("OpenAPI Idempotency-Key headers", () => {
  // Declared routes with no public operation yet; adding one is deliberate.
  const UNDOCUMENTED: readonly string[] = [
    // Dashboard-only CSR registration must not be promoted to a public API.
    ...INTERNAL_IDEMPOTENCY_REQUIRED_ROUTES,
  ];

  function declaredModes() {
    const modes = new Map<string, ReturnType<typeof declaredIdempotency>>();
    for (const step of stableMutatingRouteSteps()) {
      const key = step.route.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
      const mode = declaredIdempotency(step.handler);
      if (mode !== undefined || !modes.has(key)) modes.set(key, mode ?? modes.get(key));
    }
    return modes;
  }

  const doc = createOpenApiDocument();

  function idempotencyHeaderOf(route: string) {
    return (operationFor(doc, route)?.parameters ?? []).find(
      (parameter) =>
        "in" in parameter && parameter.in === "header" && parameter.name === "Idempotency-Key"
    );
  }

  function documentedHeader(route: string) {
    if (operationFor(doc, route) === undefined) return undefined;
    const header = idempotencyHeaderOf(route);
    if (header === undefined) return "absent";
    return "required" in header && header.required ? "required" : "accepted";
  }

  const modes = declaredModes();
  const recovering = new Set(
    stableMutatingRouteSteps()
      .filter((step) => declaredIdempotencyRecovery(step.handler) === "record")
      .map((step) => step.route.replace(/:([A-Za-z0-9_]+)/g, "{$1}"))
  );

  it("documents the header as each route's chain declares it", () => {
    const documented = [...modes].map(
      ([route, mode]) =>
        [route, documentedHeader(route) ?? "undocumented", mode ?? "absent"] as const
    );
    const drift = documented.filter(([route, header, mode]) =>
      header === "undocumented"
        ? mode !== "absent" && !UNDOCUMENTED.includes(route)
        : header !== mode
    );
    expect(drift).toEqual([]);
    expect(documented.filter(([, header]) => header === "required").length).toBeGreaterThan(0);
    expect(documented.filter(([, header]) => header === "accepted").length).toBeGreaterThan(0);
  });

  it("documents the idempotency error codes on every route that takes a key", () => {
    const missing = [...modes]
      .filter(([route, mode]) => mode !== undefined && !UNDOCUMENTED.includes(route))
      .flatMap(([route]) => {
        const responses = operationFor(doc, route)?.responses ?? {};
        return ["400", "409", "422"]
          .filter((status) => !(status in responses))
          .map((status) => `${route} ${status}`);
      });
    expect(missing).toEqual([]);
  });

  it("documents IDEMPOTENCY_KEY_OUTCOME_UNKNOWN only where the chain does not recover from its record", () => {
    const drift = [...modes]
      .filter(([route, mode]) => mode !== undefined && !UNDOCUMENTED.includes(route))
      .filter(([route]) => {
        const header = idempotencyHeaderOf(route);
        const description =
          header !== undefined && "description" in header ? header.description : "";
        return description?.includes("IDEMPOTENCY_KEY_OUTCOME_UNKNOWN") === recovering.has(route);
      })
      .map(([route]) => route);
    expect(drift).toEqual([]);
    expect(recovering.size).toBeGreaterThan(0);
  });
});

/**
 * Every route in the shared `IDEMPOTENCY_REQUIRED_ROUTES` (the list the route
 * inventory asserts against the chains) is documented as requiring the key on
 * every public surface a caller copies from: the public OpenAPI document, the
 * Postman collection, the idempotency guide and llms-full.txt. Adding a route
 * to the list fails here until each surface says so.
 */
describe("Idempotency-Key required routes on public surfaces", () => {
  it("keeps internal key-generation routes out of public API surfaces", () => {
    const publicDocument = createPublicOpenApiDocument(EXPERIMENTAL);
    for (const route of INTERNAL_IDEMPOTENCY_REQUIRED_ROUTES) {
      expect(operationFor(publicDocument, route)).toBeUndefined();
    }
  });

  const postmanItemSchema = z.object({
    get item() {
      return z.array(postmanItemSchema).optional();
    },
    request: z
      .object({
        method: z.string(),
        url: z.union([z.string(), z.object({ raw: z.string().optional() })]),
        header: z.array(z.object({ key: z.string(), value: z.string() })).optional(),
      })
      .optional(),
  });
  type PostmanItem = z.infer<typeof postmanItemSchema>;

  const toOpenApiPath = (path: string) => path.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
  const required = IDEMPOTENCY_REQUIRED_ROUTES.map((route) => {
    const [method, path] = mutatingRouteSchema.parse(route.split(" "));
    return { route, method, path: toOpenApiPath(path) };
  });
  const readDocsFile = (relative: string) =>
    readFileSync(new URL(`../../../sdp-docs/${relative}`, import.meta.url), "utf8");

  it("marks the header required in the public OpenAPI document", () => {
    const publicDocument = createPublicOpenApiDocument(EXPERIMENTAL);
    const notRequired = required
      .filter(({ method, path }) => {
        const operation = operationFor(publicDocument, `${method} ${path}`);
        const header = (operation?.parameters ?? []).find(
          (parameter) =>
            "in" in parameter && parameter.in === "header" && parameter.name === "Idempotency-Key"
        );
        return !(header !== undefined && "required" in header && header.required === true);
      })
      .map(({ route }) => route);
    expect(notRequired).toEqual([]);
  });

  it("sends a saved per-operation key from the Postman collection", () => {
    const collection = postmanItemSchema.parse(
      JSON.parse(
        readDocsFile("public/postman/solana-developer-platform-public.postman_collection.json")
      )
    );
    const keyed = new Set<string>();
    const walk = (items: PostmanItem[]) => {
      for (const item of items) {
        if (item.item) walk(item.item);
        const request = item.request;
        if (!request) continue;
        const raw = typeof request.url === "string" ? request.url : (request.url.raw ?? "");
        const header = request.header?.find((h) => h.key === "Idempotency-Key");
        if (header && /^\{\{idempotencyKey\.[^}]+\}\}$/.test(header.value)) {
          const path = raw.replace("{{baseUrl}}", "").replace(/\{\{([A-Za-z0-9_]+)\}\}/g, "{$1}");
          keyed.add(`${request.method} ${path}`);
        }
      }
    };
    walk(collection.item ?? []);
    const missing = required
      .filter(({ method, path }) => !keyed.has(`${method} ${path}`))
      .map(({ route }) => route);
    expect(missing).toEqual([]);
  });

  it("lists every required route in the idempotency guide and llms-full.txt", () => {
    const guide = readDocsFile("content/docs/developing-with-sdp/idempotency.mdx");
    const llms = readDocsFile("public/llms-full.txt");
    const missing = required.flatMap(({ route, method, path }) => {
      const line = `- \`${method} ${path}\``;
      return [
        ...(guide.includes(line) ? [] : [`guide: ${route}`]),
        ...(llms.includes(line) ? [] : [`llms-full.txt: ${route}`]),
      ];
    });
    expect(missing).toEqual([]);
  });
});
