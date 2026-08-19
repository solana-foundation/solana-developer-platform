import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";

import {
  createCustodyWalletRequestSchema,
  custodyPublicKeyResponseSchema,
  deleteWalletRequestSchema,
  errorResponseSchema,
  initializeSigningRequestSchema,
  initializeSigningResponseSchema,
  orgCustodyProviderSchema,
  setDefaultWalletRequestSchema,
  setDefaultWalletResponseSchema,
  signerCheckRequestSchema,
  switchSigningRequestSchema,
  switchSigningResponseSchema,
  updateCustodyWalletRequestSchema,
  walletIdParamSchema,
} from "../schemas";
import { errorResponses, jsonContent, projectScopeHeaders } from "./helpers";
import {
  custodyConfigResponse,
  custodyConfigsResponse,
  custodyDeleteWalletResponse,
  custodySignerCheckResponse,
  custodySwitchOptionsResponse,
  custodyWalletAggregateResponse,
  custodyWalletByIdResponse,
  custodyWalletResponse,
  custodyWalletsResponse,
  walletApprovalRequestResponse,
  walletApprovalRequestsResponse,
} from "./responses";

export function registerCustodyPaths(registry: OpenAPIRegistry) {
  registry.registerPath({
    method: "post",
    path: "/v1/wallets/initialize",
    tags: ["Wallets"],
    summary: "Initialize wallet signing",
    operationId: "initializeWalletSigning",
    description:
      "Initializes wallet signing for the organization or project by creating an active signing configuration.",
    security: [{ apiKeyAuth: [] }],
    request: {
      body: {
        required: true,
        content: jsonContent(initializeSigningRequestSchema),
      },
    },
    responses: {
      201: {
        description: "Wallet signing initialized",
        content: jsonContent(initializeSigningResponseSchema),
      },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 409, 500]),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/v1/wallets/switch",
    tags: ["Wallets"],
    summary: "Switch wallet signing provider",
    operationId: "switchWalletSigningProvider",
    description:
      "Selects an active provider config or exact Custody Connection as the default signing target for the requested scope. Existing on-chain authorities are not rotated.",
    security: [{ apiKeyAuth: [] }],
    request: {
      body: {
        required: true,
        content: jsonContent(switchSigningRequestSchema),
      },
    },
    responses: {
      201: {
        description: "Wallet signing provider switched",
        content: jsonContent(switchSigningResponseSchema),
      },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 404, 409, 500]),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/v1/wallets",
    tags: ["Wallets"],
    summary: "Create wallet",
    operationId: "createWallet",
    description:
      "Provisions a new wallet for the effective custody target, a provider-only resolved target, or an exact Custody Connection selected by connectionId.",
    security: [{ apiKeyAuth: [] }],
    request: {
      body: {
        required: true,
        content: jsonContent(createCustodyWalletRequestSchema),
      },
    },
    responses: {
      201: {
        description: "Wallet created",
        content: jsonContent(custodyWalletResponse),
      },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 404, 409, 500, 503]),
    },
  });

  registry.registerPath({
    method: "delete",
    path: "/v1/wallets",
    tags: ["Wallets"],
    summary: "Delete wallet",
    operationId: "deleteWallet",
    description:
      "Deletes the wallet from its exact owning custody target when that Provider supports wallet deletion. Provider, when supplied, is a consistency assertion.",
    security: [{ apiKeyAuth: [] }],
    request: {
      body: {
        required: true,
        content: jsonContent(deleteWalletRequestSchema),
      },
    },
    responses: {
      200: {
        description: "Wallet deleted",
        content: jsonContent(custodyDeleteWalletResponse),
      },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 404, 409, 500]),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/v1/wallets/default-wallet",
    tags: ["Wallets"],
    summary: "Set default wallet",
    operationId: "setDefaultWallet",
    description:
      "Resolves walletId to its exact Config or Connection owner and changes only that owner's default wallet. Provider, when supplied, is a consistency assertion.",
    security: [{ apiKeyAuth: [] }],
    request: {
      body: {
        required: true,
        content: jsonContent(setDefaultWalletRequestSchema),
      },
    },
    responses: {
      200: {
        description: "Default wallet updated",
        content: jsonContent(setDefaultWalletResponseSchema),
      },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 409, 500]),
    },
  });

  registry.registerPath({
    method: "get",
    path: "/v1/wallets/config",
    tags: ["Wallets"],
    summary: "Get wallet signing config",
    operationId: "getWalletConfig",
    description:
      "Returns the resolved Config when the effective custody target is Config-owned. An effective Connection does not fabricate a Config and returns 404.",
    security: [{ apiKeyAuth: [] }],
    request: {
      headers: projectScopeHeaders,
    },
    responses: {
      200: {
        description: "Wallet signing config",
        content: jsonContent(custodyConfigResponse),
      },
      ...errorResponses(errorResponseSchema, [401, 403, 404, 500]),
    },
  });

  registry.registerPath({
    method: "get",
    path: "/v1/wallets/configs",
    tags: ["Wallets"],
    summary: "List wallet signing configs",
    operationId: "listWalletConfigs",
    description:
      "Returns active Config-owned wallet signing configurations for the requested scope. When a Connection is effective, defaultConfigId is null rather than a fabricated Config ID.",
    security: [{ apiKeyAuth: [] }],
    request: {
      headers: projectScopeHeaders,
    },
    responses: {
      200: {
        description: "Wallet signing configurations",
        content: jsonContent(custodyConfigsResponse),
      },
      ...errorResponses(errorResponseSchema, [401, 403, 500]),
    },
  });

  registry.registerPath({
    method: "get",
    path: "/v1/wallets",
    tags: ["Wallets"],
    summary: "List wallets",
    operationId: "listWallets",
    description:
      "Lists active wallets under active Config and Connection owners. Omitted or true includeAllProviders includes every eligible owner; false uses target-selection semantics. Provider narrows either mode.",
    security: [{ apiKeyAuth: [] }],
    request: {
      headers: projectScopeHeaders,
      query: z.object({
        provider: orgCustodyProviderSchema.optional(),
        includeAllProviders: z.boolean().optional(),
        includeBalances: z.boolean().optional(),
        view: z.enum(["summary"]).optional(),
      }),
    },
    responses: {
      200: {
        description: "Wallets",
        content: jsonContent(custodyWalletsResponse),
      },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 409, 500]),
    },
  });

  registry.registerPath({
    method: "get",
    path: "/v1/wallets/aggregate",
    tags: ["Wallets"],
    summary: "Aggregate wallet balances",
    operationId: "aggregateWalletBalances",
    description:
      "Aggregates tracked balances for active wallets under the same owner-aware inclusion rules as the wallet list, without exposing one aggregate-level owner or runtime-admission value.",
    security: [{ apiKeyAuth: [] }],
    request: {
      headers: projectScopeHeaders,
      query: z.object({
        provider: orgCustodyProviderSchema.optional(),
        includeAllProviders: z.boolean().optional(),
      }),
    },
    responses: {
      200: {
        description: "Aggregated wallet balances",
        content: jsonContent(custodyWalletAggregateResponse),
      },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 409, 500]),
    },
  });

  registry.registerPath({
    method: "get",
    path: "/v1/wallets/switch-options",
    tags: ["Wallets"],
    summary: "List switch provider options",
    operationId: "listSwitchProviderOptions",
    description:
      "Returns Provider-level switching metadata for the effective Config or Connection target while preserving durable wallet-reuse facts during temporary runtime unavailability.",
    security: [{ apiKeyAuth: [] }],
    request: {
      headers: projectScopeHeaders,
    },
    responses: {
      200: {
        description: "Provider switch options",
        content: jsonContent(custodySwitchOptionsResponse),
      },
      ...errorResponses(errorResponseSchema, [401, 403, 500]),
    },
  });

  registry.registerPath({
    method: "get",
    path: "/v1/wallets/public-key",
    tags: ["Wallets"],
    summary: "Get wallet public key",
    operationId: "getWalletPublicKey",
    description:
      "Returns the persisted public key for an exact active walletId, or for the effective active custody target when walletId is omitted. Resolution is DB-backed only.",
    security: [{ apiKeyAuth: [] }],
    request: {
      headers: projectScopeHeaders,
      query: z.object({
        walletId: walletIdParamSchema.optional(),
      }),
    },
    responses: {
      200: {
        description: "Wallet public key",
        content: jsonContent(custodyPublicKeyResponseSchema),
      },
      ...errorResponses(errorResponseSchema, [401, 403, 404, 409, 500]),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/v1/wallets/signer-check",
    tags: ["Wallets"],
    summary: "Check signer via memo transaction",
    operationId: "checkWalletSigner",
    description:
      "Submits a server-authored memo transaction using the wallet selected by an authenticated API key or dashboard session. The wallet is the only readonly signer, Kora pays the fee, and the request cannot supply memo text.",
    security: [{ apiKeyAuth: [] }],
    request: {
      headers: projectScopeHeaders,
      body: {
        required: true,
        content: jsonContent(signerCheckRequestSchema),
      },
    },
    responses: {
      200: {
        description: "Signer check transaction submitted",
        content: jsonContent(custodySignerCheckResponse),
      },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 429, 500, 502]),
    },
  });

  registry.registerPath({
    method: "get",
    path: "/v1/wallets/approval-requests",
    tags: ["Wallets"],
    summary: "List wallet approval requests",
    operationId: "listWalletApprovalRequests",
    description:
      "Lists wallet operation approval requests for the authenticated organization or project scope.",
    security: [{ apiKeyAuth: [] }],
    request: {
      headers: projectScopeHeaders,
      query: z.object({
        status: z
          .enum(["pending", "approved", "rejected", "canceled", "expired", "failed"])
          .optional()
          .openapi({ description: "Filter by approval request status.", example: "pending" }),
        limit: z.number().int().min(1).max(100).optional().openapi({
          description: "Maximum approval requests to return.",
          example: 50,
        }),
      }),
    },
    responses: {
      200: {
        description: "Wallet approval requests",
        content: jsonContent(walletApprovalRequestsResponse),
      },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 500]),
    },
  });

  registry.registerPath({
    method: "get",
    path: "/v1/wallets/approval-requests/{approvalRequestId}",
    tags: ["Wallets"],
    summary: "Get wallet approval request",
    operationId: "getWalletApprovalRequest",
    description: "Returns one wallet operation approval request with operation and policy context.",
    security: [{ apiKeyAuth: [] }],
    request: {
      headers: projectScopeHeaders,
      params: z.object({
        approvalRequestId: z.string().openapi({
          description: "Approval request ID.",
          example: "appr_example",
        }),
      }),
    },
    responses: {
      200: {
        description: "Wallet approval request",
        content: jsonContent(walletApprovalRequestResponse),
      },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 404, 500]),
    },
  });

  for (const action of ["approve", "reject", "cancel"] as const) {
    const authorization =
      action === "cancel"
        ? "The requester may cancel its own request; otherwise the resolver must be an active member of the assigned approval group, or an organization/API admin when no group is assigned. A user and the API keys they created are treated as the same requester."
        : "The resolver must differ from the requester, including across a user session and API keys created by that user, and be an active member of the assigned approval group, or an organization/API admin when no group is assigned.";
    registry.registerPath({
      method: "post",
      path: `/v1/wallets/approval-requests/{approvalRequestId}/${action}`,
      tags: ["Wallets"],
      summary: `${action[0].toUpperCase()}${action.slice(1)} wallet approval request`,
      operationId: `${action}WalletApprovalRequest`,
      description: `${action[0].toUpperCase()}${action.slice(1)}s a pending wallet operation approval request. ${authorization}`,
      security: [{ apiKeyAuth: [] }],
      request: {
        headers: projectScopeHeaders,
        params: z.object({
          approvalRequestId: z.string().openapi({
            description: "Approval request ID.",
            example: "appr_example",
          }),
        }),
      },
      responses: {
        200: {
          description: "Wallet approval request",
          content: jsonContent(walletApprovalRequestResponse),
        },
        ...errorResponses(errorResponseSchema, [400, 401, 403, 404, 409, 500]),
      },
    });
  }

  registry.registerPath({
    method: "get",
    path: "/v1/wallets/{walletId}",
    tags: ["Wallets"],
    summary: "Get wallet by ID",
    operationId: "getWalletById",
    description:
      "Returns active wallet metadata, exact Config or Connection ownership, runtime execution admission, Provider, public key, and by default the current SOL balance. Set includeBalance=false for a metadata-only read.",
    security: [{ apiKeyAuth: [] }],
    request: {
      params: z.object({
        walletId: walletIdParamSchema,
      }),
      headers: projectScopeHeaders,
      query: z.object({
        includeBalance: z.enum(["true", "false"]).optional().openapi({
          description:
            "Whether to resolve the current SOL balance. Defaults to true; false returns metadata without balance RPC or pricing calls.",
          example: "false",
        }),
      }),
    },
    responses: {
      200: {
        description: "Wallet details",
        content: jsonContent(custodyWalletByIdResponse),
      },
      ...errorResponses(errorResponseSchema, [401, 403, 404, 409, 500]),
    },
  });

  registry.registerPath({
    method: "patch",
    path: "/v1/wallets/{walletId}",
    tags: ["Wallets"],
    summary: "Update wallet",
    operationId: "updateWallet",
    description:
      "Updates the display label of an active wallet under its exact Config or Connection owner.",
    security: [{ apiKeyAuth: [] }],
    request: {
      params: z.object({
        walletId: walletIdParamSchema,
      }),
      headers: projectScopeHeaders,
      body: {
        required: true,
        content: jsonContent(updateCustodyWalletRequestSchema),
      },
    },
    responses: {
      200: {
        description: "Wallet updated",
        content: jsonContent(custodyWalletResponse),
      },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 404, 409, 500]),
    },
  });
}
