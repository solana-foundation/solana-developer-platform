import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import { TOKEN_TRANSACTION_TYPES } from "@sdp/types";
import { z } from "zod";

import {
  addTokenAllowlistRequestSchema,
  allowlistEntryIdParamSchema,
  burnRequestSchema,
  createTokenRequestSchema,
  errorResponseSchema,
  forceBurnRequestSchema,
  freezeAccountRequestSchema,
  mintRequestSchema,
  pageQuerySchema,
  pageSizeQuerySchema,
  pauseTokenRequestSchema,
  seizeRequestSchema,
  templateIdParamSchema,
  tokenIdParamSchema,
  tokenStatusQuerySchema,
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
  prepareDeployResponse,
  prepareForceBurnResponse,
  prepareMintResponse,
  prepareSeizeResponse,
  prepareUpdateAuthorityResponse,
  tokenAllowlistListResponse,
  tokenAllowlistResponse,
  tokenListResponse,
  tokenResponse,
  tokenTemplateResponse,
  tokenTransactionsResponse,
} from "./responses";

const tokenTransactionTypeQuerySchema = z
  .enum(TOKEN_TRANSACTION_TYPES)
  .openapi({ description: "Filter by token transaction type.", example: "burn" });

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
    description: "Lists tokens for the current project or organization.",
    security: [{ apiKeyAuth: [] }],
    request: {
      headers: projectScopeHeaders,
      query: z.object({
        status: tokenStatusQuerySchema.optional(),
        page: pageQuerySchema.optional(),
        pageSize: pageSizeQuerySchema.optional(),
      }),
    },
    responses: {
      200: {
        description: "Token list",
        content: jsonContent(tokenListResponse),
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
      ...errorResponses(errorResponseSchema, [400, 401, 403, 404, 500]),
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
      ...errorResponses(errorResponseSchema, [400, 401, 403, 404, 500]),
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
      }),
    },
    responses: {
      200: {
        description: "Allowlist entries",
        content: jsonContent(tokenAllowlistListResponse),
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
}
