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
  projectIdParamSchema,
  setDefaultWalletRequestSchema,
  setDefaultWalletResponseSchema,
  signerCheckRequestSchema,
  switchSigningRequestSchema,
  updateCustodyWalletRequestSchema,
  walletIdParamSchema,
} from "../schemas";
import { errorResponses, jsonContent } from "./helpers";
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
      "Ensures the target provider is active and sets it as the default signing provider for the requested scope. Existing on-chain authorities are not rotated.",
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
        content: jsonContent(initializeSigningResponseSchema),
      },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 500]),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/v1/wallets",
    tags: ["Wallets"],
    summary: "Create wallet",
    operationId: "createWallet",
    description:
      "Provisions a new wallet for the resolved default signing provider configuration, or for an explicitly targeted provider.",
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
      ...errorResponses(errorResponseSchema, [400, 401, 403, 409, 500]),
    },
  });

  registry.registerPath({
    method: "delete",
    path: "/v1/wallets",
    tags: ["Wallets"],
    summary: "Delete wallet",
    operationId: "deleteWallet",
    description:
      "Deletes a wallet from the resolved default signing provider configuration, or from an explicitly targeted provider when that provider supports wallet deletion.",
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
      "Sets the default wallet for the resolved default provider config, or for an explicitly targeted provider.",
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
      "Returns the resolved default wallet signing configuration for the organization or project. Resolution is DB-backed only (no environment fallback).",
    security: [{ apiKeyAuth: [] }],
    request: {
      query: z.object({
        projectId: projectIdParamSchema.optional(),
      }),
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
      "Returns active wallet signing configurations for the requested scope plus the resolved default configuration ID.",
    security: [{ apiKeyAuth: [] }],
    request: {
      query: z.object({
        projectId: projectIdParamSchema.optional(),
      }),
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
      "Lists wallets across all active providers for the requested scope. Use provider to filter to a specific provider.",
    security: [{ apiKeyAuth: [] }],
    request: {
      query: z.object({
        projectId: projectIdParamSchema.optional(),
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
      ...errorResponses(errorResponseSchema, [401, 403, 500]),
    },
  });

  registry.registerPath({
    method: "get",
    path: "/v1/wallets/aggregate",
    tags: ["Wallets"],
    summary: "Aggregate wallet balances",
    operationId: "aggregateWalletBalances",
    description:
      "Aggregates tracked wallet balances for the requested scope. Defaults to aggregating across all active providers for the organization scope.",
    security: [{ apiKeyAuth: [] }],
    request: {
      query: z.object({
        projectId: projectIdParamSchema.optional(),
        provider: orgCustodyProviderSchema.optional(),
        includeAllProviders: z.boolean().optional(),
      }),
    },
    responses: {
      200: {
        description: "Aggregated wallet balances",
        content: jsonContent(custodyWalletAggregateResponse),
      },
      ...errorResponses(errorResponseSchema, [401, 403, 500]),
    },
  });

  registry.registerPath({
    method: "get",
    path: "/v1/wallets/switch-options",
    tags: ["Wallets"],
    summary: "List switch provider options",
    operationId: "listSwitchProviderOptions",
    description:
      "Returns provider capability metadata, including active/default status for the requested scope.",
    security: [{ apiKeyAuth: [] }],
    request: {
      query: z.object({
        projectId: projectIdParamSchema.optional(),
      }),
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
      "Returns the resolved wallet public key for transaction construction. Resolution is DB-backed only (no environment fallback).",
    security: [{ apiKeyAuth: [] }],
    request: {
      query: z.object({
        projectId: projectIdParamSchema.optional(),
        walletId: walletIdParamSchema.optional(),
      }),
    },
    responses: {
      200: {
        description: "Wallet public key",
        content: jsonContent(custodyPublicKeyResponseSchema),
      },
      ...errorResponses(errorResponseSchema, [401, 403, 404, 500]),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/v1/wallets/signer-check",
    tags: ["Wallets"],
    summary: "Check signer via memo transaction",
    operationId: "checkWalletSigner",
    description:
      "Submits a memo transaction using the wallet bound to the authenticated API key. This endpoint requires API-key authentication.",
    security: [{ apiKeyAuth: [] }],
    request: {
      body: {
        required: false,
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
    path: "/v1/wallets/{walletId}",
    tags: ["Wallets"],
    summary: "Get wallet by ID",
    operationId: "getWalletById",
    description:
      "Returns wallet metadata, custody provider, public key, and current SOL balance for a specific wallet ID. This endpoint requires authenticated access.",
    security: [{ apiKeyAuth: [] }],
    request: {
      params: z.object({
        walletId: walletIdParamSchema,
      }),
      query: z.object({
        projectId: projectIdParamSchema.optional(),
      }),
    },
    responses: {
      200: {
        description: "Wallet details",
        content: jsonContent(custodyWalletByIdResponse),
      },
      ...errorResponses(errorResponseSchema, [401, 403, 404, 500]),
    },
  });

  registry.registerPath({
    method: "patch",
    path: "/v1/wallets/{walletId}",
    tags: ["Wallets"],
    summary: "Update wallet",
    operationId: "updateWallet",
    description: "Updates editable wallet metadata such as the display label.",
    security: [{ apiKeyAuth: [] }],
    request: {
      params: z.object({
        walletId: walletIdParamSchema,
      }),
      query: z.object({
        projectId: projectIdParamSchema.optional(),
      }),
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
      ...errorResponses(errorResponseSchema, [400, 401, 403, 404, 500]),
    },
  });
}
