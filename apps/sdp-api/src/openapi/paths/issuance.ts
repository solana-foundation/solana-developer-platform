import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import { TOKEN_TRANSACTION_TYPES } from "@sdp/types/tokens";
import { z } from "zod";
import {
  allowlistEntryIdParamSchema,
  custodyWalletIdParamSchema,
  errorResponseSchema,
  pageQuerySchema,
  pageSizeQuerySchema,
  tokenIdParamSchema,
  tokenTransactionStatusQuerySchema,
} from "@/openapi/schemas/base";
import {
  addTokenAllowlistRequestSchema,
  burnRequestSchema,
  confirmDeployRequestSchema,
  createTokenRequestSchema,
  deployTokenRequestSchema,
  forceBurnRequestSchema,
  freezeAccountRequestSchema,
  getTokenQueryOpenApiSchema,
  listTokensQueryOpenApiSchema,
  mintRequestSchema,
  pauseTokenRequestSchema,
  prepareDeployRequestSchema,
  removeTokenAllowlistQuerySchema,
  seizeRequestSchema,
  templateIdParamSchema,
  unfreezeAccountRequestSchema,
  updateAuthorityRequestSchema,
  updateTokenRequestSchema,
} from "@/openapi/schemas/issuance";
import {
  DOCS_GROUP,
  errorResponses,
  jsonContent,
  projectScopeHeaders,
  projectScopeWithIdempotencyHeaders,
} from "./helpers";
import {
  assetAuditListResponse,
  executeBurnResponse,
  executeForceBurnResponse,
  executeMintResponse,
  executePauseResponse,
  executeSeizeResponse,
  executeUnpauseResponse,
  executeUpdateAuthorityResponse,
  frozenAccountListResponse,
  frozenAccountResponse,
  issuanceTransactionsResponse,
  listTemplatesResponse,
  prepareBurnResponse,
  prepareDeployMetadataResponse,
  prepareDeployResponse,
  prepareForceBurnResponse,
  prepareMintResponse,
  prepareSeizeResponse,
  prepareUpdateAuthorityResponse,
  tokenAllowlistLabelsResponse,
  tokenAllowlistListResponse,
  tokenAllowlistResponse,
  tokenListFacetsResponse,
  tokenListResponse,
  tokenResponse,
  tokenTemplateResponse,
  tokenTransactionsResponse,
} from "./responses";

/** Where each Issuance operation sits in the API reference (`DOCS_GROUP`). */
export const ISSUANCE_GROUPS = {
  templates: "Templates",
  tokens: "Tokens",
  activity: "Activity",
  deploy: "Deploy",
  mintAndBurn: "Mint and burn",
  enforcement: "Enforcement",
  authority: "Authority",
  allowlist: "Allowlist",
  holders: "Holders",
} as const;

const tokenTransactionTypeQuerySchema = z
  .enum(TOKEN_TRANSACTION_TYPES)
  .openapi({ description: "Filter by token transaction type.", example: "burn" });

const allowlistSearchQuerySchema = z.string().openapi({
  description:
    "Contains-style search over the entry address and label. A blank value is treated as no search filter.",
  example: "So1",
});

const allowlistLabelQuerySchema = z.string().openapi({
  description: "Filter to entries with this exact label (values come from the labels endpoint).",
  example: "Treasury",
});

export function registerIssuancePaths(registry: OpenAPIRegistry) {
  // ═══════════════════════════════════════════════════════════════════════════
  // Templates
  // ═══════════════════════════════════════════════════════════════════════════

  registry.registerPath({
    method: "get",
    path: "/v1/issuance/templates",
    tags: ["Issuance"],
    [DOCS_GROUP]: ISSUANCE_GROUPS.templates,
    summary: "List token templates",
    operationId: "listTokenTemplates",
    description:
      "Returns all available token templates with their default configuration and supported extensions.",
    security: [{ apiKeyAuth: [] }],
    request: {
      headers: projectScopeHeaders,
    },
    responses: {
      200: {
        description: "Template list",
        content: jsonContent(listTemplatesResponse),
      },
      ...errorResponses(errorResponseSchema, [401, 403, 500]),
    },
  });

  registry.registerPath({
    method: "get",
    path: "/v1/issuance/templates/{templateId}",
    tags: ["Issuance"],
    [DOCS_GROUP]: ISSUANCE_GROUPS.templates,
    summary: "Get token template",
    operationId: "getTokenTemplate",
    description:
      "Returns details for a specific token template including default decimals, required extensions, and available overrides.",
    security: [{ apiKeyAuth: [] }],
    request: {
      headers: projectScopeHeaders,
      params: z.object({
        templateId: templateIdParamSchema,
      }),
    },
    responses: {
      200: {
        description: "Template details",
        content: jsonContent(tokenTemplateResponse),
      },
      ...errorResponses(errorResponseSchema, [401, 403, 404, 500]),
    },
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Tokens
  // ═══════════════════════════════════════════════════════════════════════════

  registry.registerPath({
    method: "post",
    path: "/v1/issuance/tokens",
    tags: ["Issuance"],
    [DOCS_GROUP]: ISSUANCE_GROUPS.tokens,
    summary: "Create token",
    operationId: "createToken",
    description: "Creates a token record that can later be deployed to Solana.",
    security: [{ apiKeyAuth: [] }],
    request: {
      headers: projectScopeHeaders,
      body: {
        required: true,
        content: jsonContent(createTokenRequestSchema),
      },
    },
    responses: {
      201: {
        description: "Token created",
        content: jsonContent(tokenResponse),
      },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 422, 500]),
    },
  });

  registry.registerPath({
    method: "get",
    path: "/v1/issuance/tokens",
    tags: ["Issuance"],
    [DOCS_GROUP]: ISSUANCE_GROUPS.tokens,
    summary: "List tokens",
    operationId: "listTokens",
    description:
      "Lists tokens for the current project or organization. Supports contains-style search, filtering and sorting; `meta.total` always reflects the active filters. Ordering carries an id tiebreaker, so paging is stable across tokens that share a timestamp or name.",
    security: [{ apiKeyAuth: [] }],
    request: {
      headers: projectScopeHeaders,
      query: listTokensQueryOpenApiSchema,
    },
    responses: {
      200: {
        description: "Token list",
        content: jsonContent(tokenListResponse),
      },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 500]),
    },
  });

  registry.registerPath({
    method: "get",
    path: "/v1/issuance/tokens/facets",
    tags: ["Issuance"],
    [DOCS_GROUP]: ISSUANCE_GROUPS.tokens,
    summary: "List token filter facets",
    operationId: "listTokenFacets",
    description:
      "Returns the filter choices available for the project's token list — template ids in use, counts per lifecycle state, and the unfiltered total. Deliberately unaffected by list filters, so a client can offer the full set of options while showing a filtered page.",
    security: [{ apiKeyAuth: [] }],
    request: {
      headers: projectScopeHeaders,
    },
    responses: {
      200: {
        description: "Token filter facets",
        content: jsonContent(tokenListFacetsResponse),
      },
      ...errorResponses(errorResponseSchema, [401, 403, 500]),
    },
  });

  registry.registerPath({
    method: "get",
    path: "/v1/issuance/transactions",
    tags: ["Issuance"],
    [DOCS_GROUP]: ISSUANCE_GROUPS.activity,
    summary: "List issuance transactions",
    operationId: "listIssuanceTransactions",
    description:
      "Lists issuance transactions across tokens for the current organization or project. Use repeated type query parameters, for example type=burn&type=force_burn, to request multiple transaction types. Use custodyWalletId for address and associated-token-account participation history. The retired walletId parameter is rejected, including empty or mixed requests.",
    security: [{ apiKeyAuth: [] }],
    request: {
      headers: projectScopeHeaders,
      query: z.object({
        custodyWalletId: custodyWalletIdParamSchema.optional().openapi({
          description:
            "Filter to transactions where this exact SDP wallet's address participated. This is participant history, not a signer-only filter.",
        }),
        type: z
          .array(tokenTransactionTypeQuerySchema)
          .optional()
          .openapi({
            description:
              "Filter by transaction type. Repeat this query parameter for multiple values, for example type=burn&type=force_burn.",
            example: ["burn", "force_burn"],
          }),
        status: tokenTransactionStatusQuerySchema.optional(),
        page: pageQuerySchema.optional(),
        pageSize: pageSizeQuerySchema.optional(),
      }),
    },
    responses: {
      200: {
        description: "Issuance transaction list",
        content: jsonContent(issuanceTransactionsResponse),
      },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 404, 500]),
    },
  });

  registry.registerPath({
    method: "get",
    path: "/v1/issuance/tokens/{tokenId}",
    tags: ["Issuance"],
    [DOCS_GROUP]: ISSUANCE_GROUPS.tokens,
    summary: "Get token",
    operationId: "getToken",
    description:
      "Gets token details with optional read-only authority lookups for wallet selection.",
    security: [{ apiKeyAuth: [] }],
    request: {
      headers: projectScopeHeaders,
      params: z.object({
        tokenId: tokenIdParamSchema,
      }),
      query: getTokenQueryOpenApiSchema,
    },
    responses: {
      200: {
        description: "Token",
        content: jsonContent(tokenResponse),
      },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 404, 500, 502]),
    },
  });

  registry.registerPath({
    method: "get",
    path: "/v1/issuance/tokens/{tokenId}/metadata.json",
    tags: ["Issuance"],
    [DOCS_GROUP]: ISSUANCE_GROUPS.tokens,
    summary: "Get public token metadata JSON",
    operationId: "getTokenMetadataJson",
    description:
      "Public, unauthenticated endpoint serving the SDP-hosted Token-2022 / " +
      "Metaplex fungible-compatible metadata JSON for a deployed token. This is " +
      "the URL burned into the on-chain MetadataPointer when the issuer doesn't " +
      "supply their own URI. Only deployed (on-chain) tokens are served; pending " +
      "drafts return 404.",
    request: {
      params: z.object({
        tokenId: tokenIdParamSchema,
      }),
    },
    responses: {
      200: {
        description: "Token metadata JSON",
        content: jsonContent(
          z
            .object({
              name: z.string(),
              symbol: z.string(),
              description: z.string().optional(),
              image: z.string().optional(),
            })
            .openapi("TokenMetadataJson")
        ),
      },
      ...errorResponses(errorResponseSchema, [404, 500]),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/v1/issuance/tokens/{tokenId}/supply/refresh",
    tags: ["Issuance"],
    [DOCS_GROUP]: ISSUANCE_GROUPS.tokens,
    summary: "Refresh cached token supply",
    operationId: "refreshTokenSupply",
    description: "Fetches the current on-chain supply and refreshes the cached totalSupply value.",
    security: [{ apiKeyAuth: [] }],
    request: {
      headers: projectScopeHeaders,
      params: z.object({
        tokenId: tokenIdParamSchema,
      }),
    },
    responses: {
      200: {
        description: "Token supply refreshed",
        content: jsonContent(tokenResponse),
      },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 404, 500, 502]),
    },
  });

  registry.registerPath({
    method: "get",
    path: "/v1/issuance/tokens/{tokenId}/transactions",
    tags: ["Issuance"],
    [DOCS_GROUP]: ISSUANCE_GROUPS.activity,
    summary: "List token transactions",
    operationId: "listTokenTransactions",
    description: "Lists token transactions for an issued token.",
    security: [{ apiKeyAuth: [] }],
    request: {
      headers: projectScopeHeaders,
      params: z.object({
        tokenId: tokenIdParamSchema,
      }),
      query: z.object({
        type: tokenTransactionTypeQuerySchema.optional(),
        status: tokenTransactionStatusQuerySchema.optional(),
        page: pageQuerySchema.optional(),
        pageSize: pageSizeQuerySchema.optional(),
      }),
    },
    responses: {
      200: {
        description: "Token transactions",
        content: jsonContent(tokenTransactionsResponse),
      },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 404, 500]),
    },
  });

  registry.registerPath({
    method: "get",
    path: "/v1/issuance/tokens/{tokenId}/audit",
    tags: ["Issuance"],
    [DOCS_GROUP]: ISSUANCE_GROUPS.activity,
    summary: "Get asset audit history",
    operationId: "getAssetAuditHistory",
    description:
      "Returns the aggregated audit history for an issued token: events logged against the token and its child resources (transactions, allowlist entries, frozen accounts), newest first. Supports filtering by action type.",
    security: [{ apiKeyAuth: [] }],
    request: {
      headers: projectScopeHeaders,
      params: z.object({
        tokenId: tokenIdParamSchema,
      }),
      query: z.object({
        action: z.string().optional().openapi({ description: "Filter by audit action." }),
        page: pageQuerySchema.optional(),
        pageSize: pageSizeQuerySchema.optional(),
      }),
    },
    responses: {
      200: {
        description: "Asset audit history",
        content: jsonContent(assetAuditListResponse),
      },
      ...errorResponses(errorResponseSchema, [401, 403, 404, 500]),
    },
  });

  registry.registerPath({
    method: "patch",
    path: "/v1/issuance/tokens/{tokenId}",
    tags: ["Issuance"],
    [DOCS_GROUP]: ISSUANCE_GROUPS.tokens,
    summary: "Update token",
    operationId: "updateToken",
    description:
      "Updates stored token fields. For deployed tokens, metadata fields are also written on-chain through the current metadata authority.",
    security: [{ apiKeyAuth: [] }],
    request: {
      headers: projectScopeHeaders,
      params: z.object({
        tokenId: tokenIdParamSchema,
      }),
      body: {
        required: true,
        content: jsonContent(updateTokenRequestSchema),
      },
    },
    responses: {
      200: {
        description: "Token updated",
        content: jsonContent(tokenResponse),
      },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 404, 409, 500]),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/v1/issuance/tokens/{tokenId}/deploy",
    tags: ["Issuance"],
    [DOCS_GROUP]: ISSUANCE_GROUPS.deploy,
    summary: "Deploy token",
    operationId: "deployToken",
    description: "Deploys the token to Solana using custody signing.",
    security: [{ apiKeyAuth: [] }],
    request: {
      params: z.object({
        tokenId: tokenIdParamSchema,
      }),
      headers: projectScopeWithIdempotencyHeaders,
      body: {
        required: false,
        content: jsonContent(deployTokenRequestSchema),
      },
    },
    responses: {
      200: {
        description: "Token deployed",
        content: jsonContent(tokenResponse),
      },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 404, 409, 422, 500, 502]),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/v1/issuance/tokens/{tokenId}/deploy/prepare",
    tags: ["Issuance"],
    [DOCS_GROUP]: ISSUANCE_GROUPS.deploy,
    summary: "Prepare token deploy transaction",
    operationId: "prepareDeployToken",
    description:
      "Builds an unsigned deploy transaction for client-side signing. Uses the body's optional `signingCustodyWalletId`, else the token's saved internal ID; rejects with 400 when neither exists. The request body may be omitted when the token has a saved choice. Saves the exact wallet before returning, and refuses a different choice when already pinned. Confirmation and metadata preparation use only that saved ID. The retired `signingWalletId` input is rejected.",
    security: [{ apiKeyAuth: [] }],
    request: {
      headers: projectScopeHeaders,
      params: z.object({
        tokenId: tokenIdParamSchema,
      }),
      body: {
        required: false,
        content: jsonContent(prepareDeployRequestSchema),
      },
    },
    responses: {
      200: {
        description: "Prepared deploy transaction",
        content: jsonContent(prepareDeployResponse),
      },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 404, 409, 500, 502]),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/v1/issuance/tokens/{tokenId}/deploy/confirm",
    tags: ["Issuance"],
    [DOCS_GROUP]: ISSUANCE_GROUPS.deploy,
    summary: "Confirm non-custodial deploy",
    operationId: "confirmDeploy",
    description:
      "Records the mint after the client signs and submits a prepared (non-custodial) deploy transaction. Verifies the transaction landed on-chain using the token's saved `signingCustodyWalletId`, then marks the token deployed. No wallet override is accepted. Missing saved internal identity returns 400 without reconstructing it from a provider reference or address; existing records and the on-chain result are retained. The retired `signingWalletId` input is rejected.",
    security: [{ apiKeyAuth: [] }],
    request: {
      headers: projectScopeHeaders,
      params: z.object({
        tokenId: tokenIdParamSchema,
      }),
      body: {
        required: true,
        content: jsonContent(confirmDeployRequestSchema),
      },
    },
    responses: {
      200: {
        description: "Token deployed",
        content: jsonContent(tokenResponse),
      },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 404, 409, 422, 500, 502]),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/v1/issuance/tokens/{tokenId}/deploy/prepare-metadata",
    tags: ["Issuance"],
    [DOCS_GROUP]: ISSUANCE_GROUPS.deploy,
    summary: "Prepare metadata-URI follow-up transaction",
    operationId: "prepareDeployMetadata",
    description:
      "Follow-up step for the non-custodial deploy flow. When prepareDeploy returns `metadataUriFollowUp.required` (the inline URI overflowed the create transaction), the client calls this after deploy/confirm to fetch an unsigned transaction that sets the metadata URI on-chain. Uses only the token's saved `signingCustodyWalletId`; a missing internal ID returns 400 and no provider or address lookup repairs it. Existing records and the on-chain result are retained. The retired `signingWalletId` input is rejected. Returns a null transaction when the on-chain URI already matches.",
    security: [{ apiKeyAuth: [] }],
    request: {
      headers: projectScopeHeaders,
      params: z.object({
        tokenId: tokenIdParamSchema,
      }),
    },
    responses: {
      200: {
        description: "Prepared metadata-URI follow-up transaction (or no-op)",
        content: jsonContent(prepareDeployMetadataResponse),
      },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 404, 409, 500, 502]),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/v1/issuance/tokens/{tokenId}/mint/prepare",
    tags: ["Issuance"],
    [DOCS_GROUP]: ISSUANCE_GROUPS.mintAndBurn,
    summary: "Prepare mint transaction",
    operationId: "prepareMint",
    description:
      "Builds an unsigned mint transaction for client-side signing. The authority wallet is the fee payer: it signs the transaction and pays the network fee and the rent for a new destination token account; SDP does not sponsor prepared transactions.",
    security: [{ apiKeyAuth: [] }],
    request: {
      headers: projectScopeHeaders,
      params: z.object({
        tokenId: tokenIdParamSchema,
      }),
      body: {
        required: true,
        content: jsonContent(mintRequestSchema),
      },
    },
    responses: {
      200: {
        description: "Prepared mint",
        content: jsonContent(prepareMintResponse),
      },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 404, 409, 500]),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/v1/issuance/tokens/{tokenId}/mint",
    tags: ["Issuance"],
    [DOCS_GROUP]: ISSUANCE_GROUPS.mintAndBurn,
    summary: "Execute mint",
    operationId: "executeMint",
    description: "Mints tokens using custody signing and submission.",
    security: [{ apiKeyAuth: [] }],
    request: {
      params: z.object({
        tokenId: tokenIdParamSchema,
      }),
      headers: projectScopeWithIdempotencyHeaders,
      body: {
        required: true,
        content: jsonContent(mintRequestSchema),
      },
    },
    responses: {
      200: {
        description: "Mint executed",
        content: jsonContent(executeMintResponse),
      },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 404, 409, 422, 500]),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/v1/issuance/tokens/{tokenId}/burn/prepare",
    tags: ["Issuance"],
    [DOCS_GROUP]: ISSUANCE_GROUPS.mintAndBurn,
    summary: "Prepare burn transaction",
    operationId: "prepareBurn",
    description:
      "Builds an unsigned burn transaction for client-side signing. The authority wallet is the fee payer: it signs the transaction and pays the network fee; SDP does not sponsor prepared transactions.",
    security: [{ apiKeyAuth: [] }],
    request: {
      headers: projectScopeHeaders,
      params: z.object({
        tokenId: tokenIdParamSchema,
      }),
      body: {
        required: true,
        content: jsonContent(burnRequestSchema),
      },
    },
    responses: {
      200: {
        description: "Prepared burn",
        content: jsonContent(prepareBurnResponse),
      },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 404, 409, 500]),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/v1/issuance/tokens/{tokenId}/burn",
    tags: ["Issuance"],
    [DOCS_GROUP]: ISSUANCE_GROUPS.mintAndBurn,
    summary: "Execute burn",
    operationId: "executeBurn",
    description: "Burns tokens using custody signing and submission.",
    security: [{ apiKeyAuth: [] }],
    request: {
      params: z.object({
        tokenId: tokenIdParamSchema,
      }),
      headers: projectScopeWithIdempotencyHeaders,
      body: {
        required: true,
        content: jsonContent(burnRequestSchema),
      },
    },
    responses: {
      200: {
        description: "Burn executed",
        content: jsonContent(executeBurnResponse),
      },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 404, 409, 422, 500]),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/v1/issuance/tokens/{tokenId}/seize/prepare",
    tags: ["Issuance"],
    [DOCS_GROUP]: ISSUANCE_GROUPS.enforcement,
    summary: "Prepare seize transaction",
    operationId: "prepareSeize",
    description: "Builds an unsigned force transfer transaction for client-side signing.",
    security: [{ apiKeyAuth: [] }],
    request: {
      headers: projectScopeHeaders,
      params: z.object({
        tokenId: tokenIdParamSchema,
      }),
      body: {
        required: true,
        content: jsonContent(seizeRequestSchema),
      },
    },
    responses: {
      200: {
        description: "Prepared seize",
        content: jsonContent(prepareSeizeResponse),
      },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 404, 409, 500]),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/v1/issuance/tokens/{tokenId}/seize",
    tags: ["Issuance"],
    [DOCS_GROUP]: ISSUANCE_GROUPS.enforcement,
    summary: "Execute seize",
    operationId: "executeSeize",
    description: "Forces a transfer using permanent delegate authority.",
    security: [{ apiKeyAuth: [] }],
    request: {
      params: z.object({
        tokenId: tokenIdParamSchema,
      }),
      headers: projectScopeWithIdempotencyHeaders,
      body: {
        required: true,
        content: jsonContent(seizeRequestSchema),
      },
    },
    responses: {
      200: {
        description: "Seize executed",
        content: jsonContent(executeSeizeResponse),
      },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 404, 409, 422, 500]),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/v1/issuance/tokens/{tokenId}/force-burn/prepare",
    tags: ["Issuance"],
    [DOCS_GROUP]: ISSUANCE_GROUPS.enforcement,
    summary: "Prepare force burn transaction",
    operationId: "prepareForceBurn",
    description: "Builds an unsigned force burn transaction for client-side signing.",
    security: [{ apiKeyAuth: [] }],
    request: {
      headers: projectScopeHeaders,
      params: z.object({
        tokenId: tokenIdParamSchema,
      }),
      body: {
        required: true,
        content: jsonContent(forceBurnRequestSchema),
      },
    },
    responses: {
      200: {
        description: "Prepared force burn",
        content: jsonContent(prepareForceBurnResponse),
      },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 404, 409, 500]),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/v1/issuance/tokens/{tokenId}/force-burn",
    tags: ["Issuance"],
    [DOCS_GROUP]: ISSUANCE_GROUPS.enforcement,
    summary: "Execute force burn",
    operationId: "executeForceBurn",
    description: "Burns tokens using permanent delegate authority.",
    security: [{ apiKeyAuth: [] }],
    request: {
      params: z.object({
        tokenId: tokenIdParamSchema,
      }),
      headers: projectScopeWithIdempotencyHeaders,
      body: {
        required: true,
        content: jsonContent(forceBurnRequestSchema),
      },
    },
    responses: {
      200: {
        description: "Force burn executed",
        content: jsonContent(executeForceBurnResponse),
      },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 404, 409, 422, 500]),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/v1/issuance/tokens/{tokenId}/authority/prepare",
    tags: ["Issuance"],
    [DOCS_GROUP]: ISSUANCE_GROUPS.authority,
    summary: "Prepare authority update",
    operationId: "prepareUpdateAuthority",
    description: "Builds an unsigned authority update transaction for client-side signing.",
    security: [{ apiKeyAuth: [] }],
    request: {
      headers: projectScopeHeaders,
      params: z.object({
        tokenId: tokenIdParamSchema,
      }),
      body: {
        required: true,
        content: jsonContent(updateAuthorityRequestSchema),
      },
    },
    responses: {
      200: {
        description: "Prepared authority update",
        content: jsonContent(prepareUpdateAuthorityResponse),
      },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 404, 409, 500]),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/v1/issuance/tokens/{tokenId}/authority",
    tags: ["Issuance"],
    [DOCS_GROUP]: ISSUANCE_GROUPS.authority,
    summary: "Execute authority update",
    operationId: "executeUpdateAuthority",
    description: "Updates token authorities using custody signing.",
    security: [{ apiKeyAuth: [] }],
    request: {
      params: z.object({
        tokenId: tokenIdParamSchema,
      }),
      headers: projectScopeWithIdempotencyHeaders,
      body: {
        required: true,
        content: jsonContent(updateAuthorityRequestSchema),
      },
    },
    responses: {
      200: {
        description: "Authority updated",
        content: jsonContent(executeUpdateAuthorityResponse),
      },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 404, 409, 422, 500]),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/v1/issuance/tokens/{tokenId}/pause",
    tags: ["Issuance"],
    [DOCS_GROUP]: ISSUANCE_GROUPS.enforcement,
    summary: "Pause token transfers",
    operationId: "pauseToken",
    description: "Pauses transfers for a token using the pause authority.",
    security: [{ apiKeyAuth: [] }],
    request: {
      params: z.object({
        tokenId: tokenIdParamSchema,
      }),
      headers: projectScopeWithIdempotencyHeaders,
      body: {
        required: true,
        content: jsonContent(pauseTokenRequestSchema),
      },
    },
    responses: {
      200: {
        description: "Token paused",
        content: jsonContent(executePauseResponse),
      },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 404, 409, 422, 500]),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/v1/issuance/tokens/{tokenId}/unpause",
    tags: ["Issuance"],
    [DOCS_GROUP]: ISSUANCE_GROUPS.enforcement,
    summary: "Unpause token transfers",
    operationId: "unpauseToken",
    description: "Resumes transfers for a token using the pause authority.",
    security: [{ apiKeyAuth: [] }],
    request: {
      params: z.object({
        tokenId: tokenIdParamSchema,
      }),
      headers: projectScopeWithIdempotencyHeaders,
      body: {
        required: true,
        content: jsonContent(pauseTokenRequestSchema),
      },
    },
    responses: {
      200: {
        description: "Token unpaused",
        content: jsonContent(executeUnpauseResponse),
      },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 404, 409, 422, 500]),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/v1/issuance/tokens/{tokenId}/freeze",
    tags: ["Issuance"],
    [DOCS_GROUP]: ISSUANCE_GROUPS.enforcement,
    summary: "Freeze account",
    operationId: "freezeAccount",
    description: "Freezes a token account to prevent transfers.",
    security: [{ apiKeyAuth: [] }],
    request: {
      params: z.object({
        tokenId: tokenIdParamSchema,
      }),
      headers: projectScopeWithIdempotencyHeaders,
      body: {
        required: true,
        content: jsonContent(freezeAccountRequestSchema),
      },
    },
    responses: {
      201: {
        description: "Account frozen",
        content: jsonContent(frozenAccountResponse),
      },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 404, 409, 422, 500]),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/v1/issuance/tokens/{tokenId}/unfreeze",
    tags: ["Issuance"],
    [DOCS_GROUP]: ISSUANCE_GROUPS.enforcement,
    summary: "Unfreeze account",
    operationId: "unfreezeAccount",
    description: "Unfreezes a token account so it can be used again.",
    security: [{ apiKeyAuth: [] }],
    request: {
      params: z.object({
        tokenId: tokenIdParamSchema,
      }),
      headers: projectScopeWithIdempotencyHeaders,
      body: {
        required: true,
        content: jsonContent(unfreezeAccountRequestSchema),
      },
    },
    responses: {
      200: {
        description: "Account unfrozen",
        content: jsonContent(frozenAccountResponse),
      },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 404, 409, 422, 500]),
    },
  });

  registry.registerPath({
    method: "get",
    path: "/v1/issuance/tokens/{tokenId}/frozen",
    tags: ["Issuance"],
    [DOCS_GROUP]: ISSUANCE_GROUPS.enforcement,
    summary: "List frozen accounts",
    operationId: "listFrozenAccounts",
    description: "Lists frozen accounts for a token.",
    security: [{ apiKeyAuth: [] }],
    request: {
      headers: projectScopeHeaders,
      params: z.object({
        tokenId: tokenIdParamSchema,
      }),
      query: z.object({
        page: pageQuerySchema.optional(),
        pageSize: pageSizeQuerySchema.optional(),
      }),
    },
    responses: {
      200: {
        description: "Frozen accounts",
        content: jsonContent(frozenAccountListResponse),
      },
      ...errorResponses(errorResponseSchema, [401, 403, 404, 500]),
    },
  });

  registry.registerPath({
    method: "get",
    path: "/v1/issuance/tokens/{tokenId}/allowlist",
    tags: ["Issuance"],
    [DOCS_GROUP]: ISSUANCE_GROUPS.allowlist,
    summary: "List token allowlist",
    operationId: "listTokenAllowlist",
    description: "Lists allowlist entries for a token.",
    security: [{ apiKeyAuth: [] }],
    request: {
      headers: projectScopeHeaders,
      params: z.object({
        tokenId: tokenIdParamSchema,
      }),
      query: z.object({
        page: pageQuerySchema.optional(),
        pageSize: pageSizeQuerySchema.optional(),
        search: allowlistSearchQuerySchema.optional(),
        label: allowlistLabelQuerySchema.optional(),
      }),
    },
    responses: {
      200: {
        description: "Allowlist entries",
        content: jsonContent(tokenAllowlistListResponse),
      },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 404, 500]),
    },
  });

  registry.registerPath({
    method: "get",
    path: "/v1/issuance/tokens/{tokenId}/allowlist/labels",
    tags: ["Issuance"],
    [DOCS_GROUP]: ISSUANCE_GROUPS.allowlist,
    summary: "List token allowlist labels",
    operationId: "listTokenAllowlistLabels",
    description:
      "Lists the distinct labels used across a token's active control-list entries, for building a label filter.",
    security: [{ apiKeyAuth: [] }],
    request: {
      headers: projectScopeHeaders,
      params: z.object({
        tokenId: tokenIdParamSchema,
      }),
    },
    responses: {
      200: {
        description: "Distinct allowlist labels",
        content: jsonContent(tokenAllowlistLabelsResponse),
      },
      ...errorResponses(errorResponseSchema, [401, 403, 404, 500]),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/v1/issuance/tokens/{tokenId}/allowlist",
    tags: ["Issuance"],
    [DOCS_GROUP]: ISSUANCE_GROUPS.allowlist,
    summary: "Add token allowlist entry",
    operationId: "addTokenAllowlistEntry",
    description: "Adds an allowlist entry for a token.",
    security: [{ apiKeyAuth: [] }],
    request: {
      headers: projectScopeHeaders,
      params: z.object({
        tokenId: tokenIdParamSchema,
      }),
      body: {
        required: true,
        content: jsonContent(addTokenAllowlistRequestSchema),
      },
    },
    responses: {
      201: {
        description: "Allowlist entry added",
        content: jsonContent(tokenAllowlistResponse),
      },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 404, 409, 422, 500]),
    },
  });

  registry.registerPath({
    method: "delete",
    path: "/v1/issuance/tokens/{tokenId}/allowlist/{entryId}",
    tags: ["Issuance"],
    [DOCS_GROUP]: ISSUANCE_GROUPS.allowlist,
    summary: "Remove token allowlist entry",
    operationId: "removeTokenAllowlistEntry",
    description: "Removes an allowlist entry from a token.",
    security: [{ apiKeyAuth: [] }],
    request: {
      headers: projectScopeHeaders,
      params: z.object({
        tokenId: tokenIdParamSchema,
        entryId: allowlistEntryIdParamSchema,
      }),
      query: removeTokenAllowlistQuerySchema,
    },
    responses: {
      204: {
        description: "Allowlist entry removed",
      },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 404, 409, 500]),
    },
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Verified holders
  // ═══════════════════════════════════════════════════════════════════════════

  const enrollHolderRequestSchema = z
    .object({
      walletAddress: z.string(),
      counterpartyId: z.string().nullish(),
      reviewMode: z.enum(["auto", "manual"]).optional(),
    })
    .openapi("EnrollHolderRequest");

  const envelope = (inner: z.ZodTypeAny, name: string) =>
    z.object({ data: inner, meta: z.record(z.string(), z.unknown()).optional() }).openapi(name);
  const holdersResponse = envelope(
    z.object({ holders: z.array(z.record(z.string(), z.unknown())) }),
    "HoldersResponse"
  );
  const holderResponse = envelope(
    z.object({ enrollment: z.record(z.string(), z.unknown()) }),
    "HolderResponse"
  );

  registry.registerPath({
    method: "get",
    path: "/v1/issuance/tokens/{tokenId}/holders",
    tags: ["Issuance"],
    [DOCS_GROUP]: ISSUANCE_GROUPS.holders,
    summary: "List verified holders",
    operationId: "listHolders",
    description: "Returns the wallets enrolled for this asset (KYC identity + enrollment state).",
    security: [{ apiKeyAuth: [] }],
    request: { headers: projectScopeHeaders, params: z.object({ tokenId: tokenIdParamSchema }) },
    responses: {
      200: { description: "Enrolled holders", content: jsonContent(holdersResponse) },
      ...errorResponses(errorResponseSchema, [401, 403, 404, 500]),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/v1/issuance/tokens/{tokenId}/holders",
    tags: ["Issuance"],
    [DOCS_GROUP]: ISSUANCE_GROUPS.holders,
    summary: "Enroll a verified holder",
    operationId: "enrollHolder",
    description:
      "Registers a wallet for this asset (upserts its KYC identity + an active enrollment).",
    security: [{ apiKeyAuth: [] }],
    request: {
      headers: projectScopeHeaders,
      params: z.object({ tokenId: tokenIdParamSchema }),
      body: { required: true, content: jsonContent(enrollHolderRequestSchema) },
    },
    responses: {
      201: { description: "Holder enrolled", content: jsonContent(holderResponse) },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 404, 500]),
    },
  });
}
