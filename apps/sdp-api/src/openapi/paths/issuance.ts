import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";

import {
  addTokenAllowlistRequestSchema,
  allowlistEntryIdParamSchema,
  burnRequestSchema,
  createTokenRequestSchema,
  errorResponseSchema,
  freezeAccountRequestSchema,
  mintRequestSchema,
  pageQuerySchema,
  pageSizeQuerySchema,
  templateIdParamSchema,
  tokenIdParamSchema,
  tokenStatusQuerySchema,
  unfreezeAccountRequestSchema,
  updateTokenRequestSchema,
} from "../schemas";
import { errorResponses, jsonContent } from "./helpers";
import {
  executeBurnResponse,
  executeMintResponse,
  frozenAccountResponse,
  listTemplatesResponse,
  prepareBurnResponse,
  prepareDeployResponse,
  prepareMintResponse,
  tokenAllowlistListResponse,
  tokenAllowlistResponse,
  tokenListResponse,
  tokenResponse,
  tokenTemplateResponse,
} from "./responses";

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
    path: "/v1/issuance/tokens/{tokenId}",
    tags: ["Issuance"],
    summary: "Get token",
    operationId: "getToken",
    description: "Gets token details.",
    security: [{ apiKeyAuth: [] }],
    request: {
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
    method: "patch",
    path: "/v1/issuance/tokens/{tokenId}",
    tags: ["Issuance"],
    summary: "Update token",
    operationId: "updateToken",
    description: "Updates token metadata or status.",
    security: [{ apiKeyAuth: [] }],
    request: {
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
    path: "/v1/issuance/tokens/{tokenId}/allowlist",
    tags: ["Issuance"],
    summary: "List token allowlist",
    operationId: "listTokenAllowlist",
    description: "Lists allowlist entries for a token.",
    security: [{ apiKeyAuth: [] }],
    request: {
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
