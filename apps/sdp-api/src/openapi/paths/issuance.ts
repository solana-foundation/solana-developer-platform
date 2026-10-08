import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import { KYC_STATUSES, TOKEN_TRANSACTION_TYPES, WALLET_ENROLLMENT_STATUSES } from "@sdp/types";
import { z } from "zod";

import {
  addTokenAllowlistRequestSchema,
  allowlistEntryIdParamSchema,
  burnRequestSchema,
  confirmDeployRequestSchema,
  createTokenRequestSchema,
  custodyWalletIdParamSchema,
  deployTokenRequestSchema,
  errorResponseSchema,
  forceBurnRequestSchema,
  freezeAccountRequestSchema,
  getTokenQueryOpenApiSchema,
  isoDateTimeSchema,
  listTokensQueryOpenApiSchema,
  mintRequestSchema,
  orgIdParamSchema,
  pageQuerySchema,
  pageSizeQuerySchema,
  pauseTokenRequestSchema,
  projectIdParamSchema,
  removeTokenAllowlistQuerySchema,
  seizeRequestSchema,
  solanaAddressSchema,
  successResponseSchema,
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
      ...errorResponses(errorResponseSchema, [400, 401, 403, 422, 500]),
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
      "Lists issuance transactions across tokens for the current organization or project. Selected-wallet API keys are scoped to their token-readable wallet bindings when no wallet selector is supplied. Use repeated type query parameters, for example type=burn&type=force_burn, to request multiple transaction types. custodyWalletId and walletId cannot be combined.",
    security: [{ apiKeyAuth: [] }],
    request: {
      headers: projectScopeHeaders,
      query: z.object({
        custodyWalletId: custodyWalletIdParamSchema.optional().openapi({
          description:
            "Filter to transactions where this exact SDP wallet's address participated. This is participant history, not a signer-only filter.",
        }),
        walletId: walletIdParamSchema.optional().openapi({
          description: "Legacy Provider wallet ID filter. Cannot be combined with custodyWalletId.",
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
      ...errorResponses(errorResponseSchema, [400, 401, 403, 404, 409, 500]),
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
      ...errorResponses(errorResponseSchema, [400, 401, 403, 404, 409, 500, 502]),
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
      ...errorResponses(errorResponseSchema, [400, 401, 403, 404, 409, 422, 500, 502]),
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
      ...errorResponses(errorResponseSchema, [400, 401, 403, 404, 409, 500, 502]),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/v1/issuance/tokens/{tokenId}/mint/prepare",
    tags: ["Issuance"],
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
      ...errorResponses(errorResponseSchema, [400, 401, 403, 404, 409, 422, 500]),
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

  const reviewModeSchema = z.enum(["auto", "manual"]);

  const enrollHolderRequestSchema = z
    .object({
      walletAddress: z.string().openapi({
        description: "Solana wallet address to enroll. Must be a valid base58 address.",
        example: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
      }),
      counterpartyId: z.string().nullish().openapi({
        description:
          "Counterparty this wallet belongs to, in the same project. Null or omitted keeps any existing link.",
        example: "cpty_example",
      }),
      reviewMode: reviewModeSchema.optional().openapi({
        description: "Review mode recorded on the enrollment. Defaults to `auto`.",
        example: "auto",
      }),
    })
    .openapi("EnrollHolderRequest");

  // Field names are snake_case because the handler returns the repository rows as-is.
  const actorIdSchema = z.string().nullable().openapi({
    description:
      "Actor that first created the row: the API key ID for API-key requests, or the user ID for dashboard requests.",
    example: "key_example",
  });
  const kycStatusSchema = z.enum(KYC_STATUSES).openapi({
    description:
      "SDP-owned, provider-agnostic KYC status of the wallet. KYC providers (Mural today) write into it.",
    example: "verified",
  });
  const enrollmentFields = {
    id: z.string().openapi({
      description: "Enrollment identifier.",
      example: "wallet_asset_enrollment_example",
    }),
    organization_id: orgIdParamSchema,
    project_id: projectIdParamSchema,
    kyc_wallet_id: z.string().openapi({
      description: "KYC wallet this enrollment clears.",
      example: "kyc_wallet_example",
    }),
    token_id: tokenIdParamSchema,
    status: z.enum(WALLET_ENROLLMENT_STATUSES).openapi({
      description: "Enrollment status. An `active` enrollment clears the wallet for this token.",
      example: "active",
    }),
    review_mode: reviewModeSchema.openapi({
      description: "Review mode recorded on the enrollment.",
      example: "auto",
    }),
    created_by: actorIdSchema,
    created_at: isoDateTimeSchema.openapi({
      description: "When the wallet was first enrolled for this token.",
      example: "2026-07-02T10:00:00.000Z",
    }),
    revoked_at: isoDateTimeSchema.nullable().openapi({
      description: "When the enrollment was revoked. Null while it is active.",
      example: null,
    }),
  };

  const kycWalletSchema = z
    .object({
      id: z
        .string()
        .openapi({ description: "KYC wallet identifier.", example: "kyc_wallet_example" }),
      organization_id: orgIdParamSchema,
      project_id: projectIdParamSchema,
      wallet_address: solanaAddressSchema.openapi({
        description: "Enrolled wallet address.",
        example: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
      }),
      network: z
        .string()
        .openapi({ description: "Network of the wallet address.", example: "solana" }),
      counterparty_id: z.string().nullable().openapi({
        description: "Counterparty the wallet belongs to, when linked.",
        example: "cpty_example",
      }),
      kyc_status: kycStatusSchema,
      kyc_provider: z.string().nullable().openapi({
        description:
          "Provider that last set the KYC status, if any. Records who verified the wallet; `kyc_status` is the source of truth.",
        example: "mural",
      }),
      provider_ref: z.string().nullable().openapi({
        description:
          "Provider-side reference for the verification, when the provider supplies one.",
        example: null,
      }),
      verified_at: isoDateTimeSchema.nullable().openapi({
        description: "When the wallet became `verified`. Null in any other status.",
        example: "2026-07-02T09:30:00.000Z",
      }),
      status_changed_at: isoDateTimeSchema.openapi({
        description: "When `kyc_status` last changed. Other writes to the row leave it unchanged.",
        example: "2026-07-02T09:30:00.000Z",
      }),
      created_by: actorIdSchema,
      created_at: isoDateTimeSchema.openapi({
        description: "When the wallet was first registered.",
        example: "2026-07-01T12:00:00.000Z",
      }),
      updated_at: isoDateTimeSchema.openapi({
        description: "Last write to the row.",
        example: "2026-07-02T10:00:00.000Z",
      }),
    })
    .openapi("KycWallet", {
      description:
        "SDP-owned KYC identity for one wallet in the project. Verified once and reused across assets.",
    });

  // Not registered as a component: zod-to-openapi would mark the shared component
  // nullable because the POST response wraps it in `.nullable()`.
  const walletAssetEnrollmentSchema = z.object(enrollmentFields);

  const enrolledHolderSchema = z
    .object({
      ...enrollmentFields,
      wallet_address: solanaAddressSchema.openapi({
        description: "Address of the enrolled wallet.",
        example: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
      }),
      kyc_status: kycStatusSchema,
    })
    .openapi("EnrolledHolder", {
      description:
        "An active enrollment joined with its wallet's address and KYC status. `id` is the enrollment ID.",
    });

  const holdersResponse = successResponseSchema(
    z.object({
      holders: z.array(enrolledHolderSchema).openapi({
        description: "Active enrollments for the token, newest first.",
      }),
      total: z.number().int().nonnegative().openapi({
        description: "Total active enrollments for the token.",
        example: 1,
      }),
      page: z
        .number()
        .int()
        .positive()
        .openapi({ description: "Current page number.", example: 1 }),
      pageSize: z
        .number()
        .int()
        .positive()
        .openapi({ description: "Items per page.", example: 50 }),
    })
  ).openapi("HoldersResponse");
  const holderResponse = successResponseSchema(
    z.object({
      wallet: kycWalletSchema,
      enrollment: walletAssetEnrollmentSchema.nullable().openapi({
        description:
          "Clearance for this wallet to hold the token: the active enrollment, read back after the write. Null only if that read finds no active row.",
      }),
    })
  ).openapi("HolderResponse");

  registry.registerPath({
    method: "get",
    path: "/v1/issuance/tokens/{tokenId}/holders",
    tags: ["Issuance"],
    summary: "List verified holders",
    operationId: "listHolders",
    description:
      "Returns the token's active enrollments, newest first, each with the wallet address and KYC status.",
    security: [{ apiKeyAuth: [] }],
    request: {
      headers: projectScopeHeaders,
      params: z.object({ tokenId: tokenIdParamSchema }),
      query: z.object({
        page: pageQuerySchema.optional(),
        pageSize: pageSizeQuerySchema.optional().openapi({
          description: "Items per page. Defaults to 50; values above 200 are capped at 200.",
          example: 50,
        }),
      }),
    },
    responses: {
      200: { description: "Enrolled holders", content: jsonContent(holdersResponse) },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 404, 500]),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/v1/issuance/tokens/{tokenId}/holders",
    tags: ["Issuance"],
    summary: "Enroll a verified holder",
    operationId: "enrollHolder",
    description:
      "Registers a wallet for this asset: upserts its KYC identity and an active enrollment, and returns both.",
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
