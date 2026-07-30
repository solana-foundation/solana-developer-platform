import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import { TOKEN_TRANSACTION_TYPES } from "@sdp/types";
import { z } from "zod";

import {
  addTokenAllowlistRequestSchema,
  allowlistEntryIdParamSchema,
  burnRequestSchema,
  confirmDeployRequestSchema,
  createTokenRequestSchema,
  errorResponseSchema,
  forceBurnRequestSchema,
  freezeAccountRequestSchema,
  listTokensQueryOpenApiSchema,
  mintRequestSchema,
  pageQuerySchema,
  pageSizeQuerySchema,
  pauseTokenRequestSchema,
  seizeRequestSchema,
  templateIdParamSchema,
  tokenIdParamSchema,
  tokenTransactionStatusQuerySchema,
  unfreezeAccountRequestSchema,
  updateAuthorityRequestSchema,
  updateTokenRequestSchema,
  walletIdParamSchema,
} from "../schemas";
import {
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
      ...errorResponses(errorResponseSchema, [400, 401, 403, 500]),
    },
  });

  registry.registerPath({
    method: "get",
    path: "/v1/issuance/tokens",
    tags: ["Issuance"],
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
    summary: "List issuance transactions",
    operationId: "listIssuanceTransactions",
    description:
      "Lists issuance transactions across tokens for the current organization or project. Selected-wallet API keys are scoped to their token-readable wallet bindings when walletId is omitted. Use repeated type query parameters, for example type=burn&type=force_burn, to request multiple transaction types.",
    security: [{ apiKeyAuth: [] }],
    request: {
      headers: projectScopeHeaders,
      query: z.object({
        walletId: walletIdParamSchema.optional().openapi({
          description:
            "Filter to transactions associated with a wallet. Selected-wallet API keys must have wallet-level tokens:read for the requested wallet.",
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
    summary: "Get token",
    operationId: "getToken",
    description: "Gets token details.",
    security: [{ apiKeyAuth: [] }],
    request: {
      headers: projectScopeHeaders,
      params: z.object({
        tokenId: tokenIdParamSchema,
      }),
    },
    responses: {
      200: {
        description: "Token",
        content: jsonContent(tokenResponse),
      },
      ...errorResponses(errorResponseSchema, [401, 403, 404, 500]),
    },
  });

  registry.registerPath({
    method: "get",
    path: "/v1/issuance/tokens/{tokenId}/metadata.json",
    tags: ["Issuance"],
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
      ...errorResponses(errorResponseSchema, [400, 401, 403, 404, 500]),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/v1/issuance/tokens/{tokenId}/deploy",
    tags: ["Issuance"],
    summary: "Deploy token",
    operationId: "deployToken",
    description: "Deploys the token to Solana using custody signing.",
    security: [{ apiKeyAuth: [] }],
    request: {
      params: z.object({
        tokenId: tokenIdParamSchema,
      }),
      headers: projectScopeWithIdempotencyHeaders,
    },
    responses: {
      200: {
        description: "Token deployed",
        content: jsonContent(tokenResponse),
      },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 404, 500, 502]),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/v1/issuance/tokens/{tokenId}/deploy/prepare",
    tags: ["Issuance"],
    summary: "Prepare token deploy transaction",
    operationId: "prepareDeployToken",
    description: "Builds an unsigned deploy transaction for client-side signing.",
    security: [{ apiKeyAuth: [] }],
    request: {
      headers: projectScopeHeaders,
      params: z.object({
        tokenId: tokenIdParamSchema,
      }),
    },
    responses: {
      200: {
        description: "Prepared deploy transaction",
        content: jsonContent(prepareDeployResponse),
      },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 404, 500, 502]),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/v1/issuance/tokens/{tokenId}/deploy/confirm",
    tags: ["Issuance"],
    summary: "Confirm non-custodial deploy",
    operationId: "confirmDeploy",
    description:
      "Records the mint after the client signs and submits a prepared (non-custodial) deploy transaction. Verifies the transaction landed on-chain, then marks the token deployed.",
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
      ...errorResponses(errorResponseSchema, [400, 401, 403, 404, 500, 502]),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/v1/issuance/tokens/{tokenId}/deploy/prepare-metadata",
    tags: ["Issuance"],
    summary: "Prepare metadata-URI follow-up transaction",
    operationId: "prepareDeployMetadata",
    description:
      "Follow-up step for the non-custodial deploy flow. When prepareDeploy returns `metadataUriFollowUp.required` (the inline URI overflowed the create transaction), the client calls this after deploy/confirm to fetch an unsigned transaction that sets the metadata URI on-chain. Returns a null transaction when the on-chain URI already matches.",
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
      ...errorResponses(errorResponseSchema, [400, 401, 403, 404, 500, 502]),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/v1/issuance/tokens/{tokenId}/mint/prepare",
    tags: ["Issuance"],
    summary: "Prepare mint transaction",
    operationId: "prepareMint",
    description: "Builds an unsigned mint transaction for client-side signing.",
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
      ...errorResponses(errorResponseSchema, [400, 401, 403, 404, 500]),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/v1/issuance/tokens/{tokenId}/mint",
    tags: ["Issuance"],
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
      ...errorResponses(errorResponseSchema, [400, 401, 403, 404, 500]),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/v1/issuance/tokens/{tokenId}/burn/prepare",
    tags: ["Issuance"],
    summary: "Prepare burn transaction",
    operationId: "prepareBurn",
    description: "Builds an unsigned burn transaction for client-side signing.",
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
      ...errorResponses(errorResponseSchema, [400, 401, 403, 404, 500]),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/v1/issuance/tokens/{tokenId}/burn",
    tags: ["Issuance"],
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
      ...errorResponses(errorResponseSchema, [400, 401, 403, 404, 500]),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/v1/issuance/tokens/{tokenId}/seize/prepare",
    tags: ["Issuance"],
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
      ...errorResponses(errorResponseSchema, [400, 401, 403, 404, 500]),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/v1/issuance/tokens/{tokenId}/seize",
    tags: ["Issuance"],
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
      ...errorResponses(errorResponseSchema, [400, 401, 403, 404, 500]),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/v1/issuance/tokens/{tokenId}/force-burn/prepare",
    tags: ["Issuance"],
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
      ...errorResponses(errorResponseSchema, [400, 401, 403, 404, 500]),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/v1/issuance/tokens/{tokenId}/force-burn",
    tags: ["Issuance"],
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
      ...errorResponses(errorResponseSchema, [400, 401, 403, 404, 500]),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/v1/issuance/tokens/{tokenId}/authority/prepare",
    tags: ["Issuance"],
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
      ...errorResponses(errorResponseSchema, [400, 401, 403, 404, 500]),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/v1/issuance/tokens/{tokenId}/authority",
    tags: ["Issuance"],
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
      ...errorResponses(errorResponseSchema, [400, 401, 403, 404, 500]),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/v1/issuance/tokens/{tokenId}/pause",
    tags: ["Issuance"],
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
      ...errorResponses(errorResponseSchema, [400, 401, 403, 404, 500]),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/v1/issuance/tokens/{tokenId}/unpause",
    tags: ["Issuance"],
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
      ...errorResponses(errorResponseSchema, [400, 401, 403, 404, 500]),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/v1/issuance/tokens/{tokenId}/freeze",
    tags: ["Issuance"],
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
      ...errorResponses(errorResponseSchema, [400, 401, 403, 404, 500]),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/v1/issuance/tokens/{tokenId}/unfreeze",
    tags: ["Issuance"],
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
      ...errorResponses(errorResponseSchema, [400, 401, 403, 404, 500]),
    },
  });

  registry.registerPath({
    method: "get",
    path: "/v1/issuance/tokens/{tokenId}/frozen",
    tags: ["Issuance"],
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
      ...errorResponses(errorResponseSchema, [400, 401, 403, 404, 409, 500]),
    },
  });

  registry.registerPath({
    method: "delete",
    path: "/v1/issuance/tokens/{tokenId}/allowlist/{entryId}",
    tags: ["Issuance"],
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
    },
    responses: {
      204: {
        description: "Allowlist entry removed",
      },
      ...errorResponses(errorResponseSchema, [401, 403, 404, 500]),
    },
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Workflows (Phase 5) + Verified holders
  // ═══════════════════════════════════════════════════════════════════════════

  const workflowIdParamSchema = z.string().openapi({ example: "asset_workflow_abc123" });
  const executionIdParamSchema = z.string().openapi({ example: "workflow_execution_abc123" });
  const workflowRetryPolicySchema = z.object({
    maxAttempts: z.number().int().min(1).max(20),
    retryAfterMinutes: z.number().int().min(1),
  });
  const workflowConditionSchema = z
    .object({
      all: z.array(
        z.object({
          field: z.string(),
          op: z.enum(["eq", "neq", "in"]),
          value: z.union([z.string(), z.number(), z.array(z.union([z.string(), z.number()]))]),
        })
      ),
    })
    .openapi("WorkflowCondition");
  const workflowActionParamsSchema = z.record(z.string(), z.union([z.string(), z.number()]));

  const createWorkflowRequestSchema = z
    .object({
      triggerType: z.string().openapi({ example: "kyc_approved" }),
      actionType: z.string().openapi({ example: "allowlist_add" }),
      condition: workflowConditionSchema.nullish(),
      actionParams: workflowActionParamsSchema.optional(),
      reviewMode: z.enum(["auto", "manual"]).optional(),
      retryPolicy: workflowRetryPolicySchema.optional(),
      enabled: z.boolean().optional(),
    })
    .openapi("CreateWorkflowRequest");
  const updateWorkflowRequestSchema = z
    .object({
      condition: workflowConditionSchema.nullish(),
      actionParams: workflowActionParamsSchema.optional(),
      reviewMode: z.enum(["auto", "manual"]).optional(),
      retryPolicy: workflowRetryPolicySchema.optional(),
      enabled: z.boolean().optional(),
    })
    .openapi("UpdateWorkflowRequest");
  const enrollHolderRequestSchema = z
    .object({
      walletAddress: z.string(),
      counterpartyId: z.string().nullish(),
      reviewMode: z.enum(["auto", "manual"]).optional(),
    })
    .openapi("EnrollHolderRequest");

  const envelope = (inner: z.ZodTypeAny, name: string) =>
    z.object({ data: inner, meta: z.record(z.string(), z.unknown()).optional() }).openapi(name);
  const workflowRuleSchema = z.object({
    id: z.string(),
    token_id: z.string(),
    trigger_type: z.string(),
    action_type: z.string(),
    enabled: z.boolean(),
    review_mode: z.enum(["auto", "manual"]),
    created_at: z.string(),
  });
  const workflowExecutionSchema = z.object({
    id: z.string(),
    workflow_id: z.string(),
    trigger_type: z.string(),
    action_type: z.string(),
    status: z.enum([
      "awaiting_review",
      "pending",
      "processing",
      "succeeded",
      "failed",
      "cancelled",
    ]),
    attempt_count: z.number(),
    max_attempts: z.number(),
    error: z.string().nullable(),
    // Projected server-side to a fixed field list, so a held execution can be reviewed
    // (which wallet, what amount) without exposing every key an emitter happens to add.
    trigger_payload: z.record(z.string(), z.unknown()).openapi({
      description:
        "What the action will act on: wallet, source, destination, amount, operation, provider, counterpartyKind, fiatCurrency, cryptoToken, attempt.",
    }),
    result: z.record(z.string(), z.unknown()).openapi({
      description:
        "Outcome of the run: signature, status, notified, emailed, alreadyFrozen, alreadyThawed, mirrorFailed.",
    }),
    decided_by: z.string().nullable().openapi({
      description: "User who approved or rejected this execution; null when auto-applied.",
    }),
    decided_at: z.string().nullable(),
    created_at: z.string(),
    updated_at: z.string(),
  });
  const workflowResponse = envelope(z.object({ workflow: workflowRuleSchema }), "WorkflowResponse");
  const workflowListResponse = envelope(
    z.object({ workflows: z.array(workflowRuleSchema) }),
    "WorkflowListResponse"
  );
  const workflowCatalogResponse = envelope(
    z.object({
      triggers: z.array(z.record(z.string(), z.unknown())),
      actions: z.array(z.record(z.string(), z.unknown())),
    }),
    "WorkflowCatalogResponse"
  );
  const workflowExecutionsResponse = envelope(
    z.object({
      executions: z.array(workflowExecutionSchema),
      total: z.number(),
      page: z.number(),
      pageSize: z.number(),
    }),
    "WorkflowExecutionsResponse"
  );
  const workflowExecutionResponse = envelope(
    z.object({ execution: workflowExecutionSchema }),
    "WorkflowExecutionResponse"
  );
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
    path: "/v1/issuance/tokens/{tokenId}/workflows/catalog",
    tags: ["Issuance"],
    summary: "List the workflow catalog for an asset",
    operationId: "listWorkflowCatalog",
    description:
      "Returns the available triggers and the actions this asset supports (with a capability-gated support verdict per action).",
    security: [{ apiKeyAuth: [] }],
    request: { headers: projectScopeHeaders, params: z.object({ tokenId: tokenIdParamSchema }) },
    responses: {
      200: { description: "Workflow catalog", content: jsonContent(workflowCatalogResponse) },
      ...errorResponses(errorResponseSchema, [401, 403, 404, 500]),
    },
  });

  registry.registerPath({
    method: "get",
    path: "/v1/issuance/tokens/{tokenId}/workflows",
    tags: ["Issuance"],
    summary: "List workflow rules",
    operationId: "listWorkflows",
    description: "Returns the workflow automation rules configured for an asset.",
    security: [{ apiKeyAuth: [] }],
    request: { headers: projectScopeHeaders, params: z.object({ tokenId: tokenIdParamSchema }) },
    responses: {
      200: { description: "Workflow rules", content: jsonContent(workflowListResponse) },
      ...errorResponses(errorResponseSchema, [401, 403, 404, 500]),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/v1/issuance/tokens/{tokenId}/workflows",
    tags: ["Issuance"],
    summary: "Create a workflow rule",
    operationId: "createWorkflow",
    description:
      "Creates a WHEN → THEN automation rule. The action is capability-gated at save time; an unsupported action returns 400 with a typed reason.",
    security: [{ apiKeyAuth: [] }],
    request: {
      headers: projectScopeHeaders,
      params: z.object({ tokenId: tokenIdParamSchema }),
      body: { required: true, content: jsonContent(createWorkflowRequestSchema) },
    },
    responses: {
      201: { description: "Workflow created", content: jsonContent(workflowResponse) },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 404, 500]),
    },
  });

  registry.registerPath({
    method: "patch",
    path: "/v1/issuance/tokens/{tokenId}/workflows/{workflowId}",
    tags: ["Issuance"],
    summary: "Update a workflow rule",
    operationId: "updateWorkflow",
    description:
      "Updates a rule's condition, action params, review mode, retry policy, or enabled flag.",
    security: [{ apiKeyAuth: [] }],
    request: {
      headers: projectScopeHeaders,
      params: z.object({ tokenId: tokenIdParamSchema, workflowId: workflowIdParamSchema }),
      body: { required: true, content: jsonContent(updateWorkflowRequestSchema) },
    },
    responses: {
      200: { description: "Workflow updated", content: jsonContent(workflowResponse) },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 404, 500]),
    },
  });

  registry.registerPath({
    method: "delete",
    path: "/v1/issuance/tokens/{tokenId}/workflows/{workflowId}",
    tags: ["Issuance"],
    summary: "Delete a workflow rule",
    operationId: "deleteWorkflow",
    description:
      "Soft-deletes a rule: it stops matching and disappears from lists, while its execution history is retained.",
    security: [{ apiKeyAuth: [] }],
    request: {
      headers: projectScopeHeaders,
      params: z.object({ tokenId: tokenIdParamSchema, workflowId: workflowIdParamSchema }),
    },
    responses: {
      200: {
        description: "Workflow deleted",
        content: jsonContent(
          envelope(z.object({ deleted: z.boolean() }), "DeleteWorkflowResponse")
        ),
      },
      ...errorResponses(errorResponseSchema, [401, 403, 404, 500]),
    },
  });

  registry.registerPath({
    method: "get",
    path: "/v1/issuance/tokens/{tokenId}/workflows/executions",
    tags: ["Issuance"],
    summary: "List workflow executions",
    operationId: "listWorkflowExecutions",
    description:
      "Execution log for an asset's workflows — recent runs with status and retry state.",
    security: [{ apiKeyAuth: [] }],
    request: {
      headers: projectScopeHeaders,
      params: z.object({ tokenId: tokenIdParamSchema }),
      query: z.object({
        workflowId: workflowIdParamSchema.optional(),
        page: pageQuerySchema.optional(),
        pageSize: pageSizeQuerySchema.optional(),
      }),
    },
    responses: {
      200: { description: "Execution log", content: jsonContent(workflowExecutionsResponse) },
      ...errorResponses(errorResponseSchema, [401, 403, 404, 500]),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/v1/issuance/tokens/{tokenId}/workflows/executions/{executionId}/approve",
    tags: ["Issuance"],
    summary: "Approve a held execution",
    operationId: "approveWorkflowExecution",
    description:
      "Authorizes an awaiting-review execution: status becomes pending and the engine runs it once. Requires the permission implied by the rule's action tier — tokens:admin for sensitive and irreversible actions. Records the approver on the execution and in the audit log.",
    security: [{ apiKeyAuth: [] }],
    request: {
      headers: projectScopeHeaders,
      params: z.object({ tokenId: tokenIdParamSchema, executionId: executionIdParamSchema }),
    },
    responses: {
      200: { description: "Execution approved", content: jsonContent(workflowExecutionResponse) },
      ...errorResponses(errorResponseSchema, [401, 403, 404, 500]),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/v1/issuance/tokens/{tokenId}/workflows/executions/{executionId}/retry",
    tags: ["Issuance"],
    summary: "Retry a failed execution",
    operationId: "retryWorkflowExecution",
    description:
      "Re-attempts a failed execution: status becomes pending and the attempt counter resets. Approving a held execution is a separate endpoint.",
    security: [{ apiKeyAuth: [] }],
    request: {
      headers: projectScopeHeaders,
      params: z.object({ tokenId: tokenIdParamSchema, executionId: executionIdParamSchema }),
    },
    responses: {
      200: { description: "Execution re-queued", content: jsonContent(workflowExecutionResponse) },
      ...errorResponses(errorResponseSchema, [401, 403, 404, 500]),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/v1/issuance/tokens/{tokenId}/workflows/executions/{executionId}/reject",
    tags: ["Issuance"],
    summary: "Reject a held execution",
    operationId: "rejectWorkflowExecution",
    description: "Cancels an awaiting-review execution; the action never runs.",
    security: [{ apiKeyAuth: [] }],
    request: {
      headers: projectScopeHeaders,
      params: z.object({ tokenId: tokenIdParamSchema, executionId: executionIdParamSchema }),
    },
    responses: {
      200: { description: "Execution cancelled", content: jsonContent(workflowExecutionResponse) },
      ...errorResponses(errorResponseSchema, [401, 403, 404, 500]),
    },
  });

  registry.registerPath({
    method: "get",
    path: "/v1/issuance/tokens/{tokenId}/holders",
    tags: ["Issuance"],
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
    summary: "Enroll a verified holder",
    operationId: "enrollHolder",
    description:
      "Registers a wallet for this asset (upserts its KYC identity + an active enrollment). When the wallet's KYC is approved, matching workflows fire.",
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
