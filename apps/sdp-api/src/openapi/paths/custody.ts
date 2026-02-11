import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";

import {
  createCustodyWalletRequestSchema,
  custodyPublicKeyResponseSchema,
  errorResponseSchema,
  initializeSigningRequestSchema,
  initializeSigningResponseSchema,
  projectIdParamSchema,
  setDefaultWalletRequestSchema,
  setDefaultWalletResponseSchema,
  switchSigningRequestSchema,
  walletIdParamSchema,
} from "../schemas";
import { errorResponses, jsonContent } from "./helpers";
import { custodyConfigResponse, custodyWalletResponse, custodyWalletsResponse } from "./responses";

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
      "Switches the active wallet signing provider for the organization or project without rotating existing on-chain authorities.",
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
    description: "Provisions a new wallet for the active signing provider configuration.",
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
    method: "post",
    path: "/v1/wallets/default-wallet",
    tags: ["Wallets"],
    summary: "Set default wallet",
    operationId: "setDefaultWallet",
    description: "Sets the default wallet for the active signing configuration.",
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
    description: "Returns the active wallet signing configuration for the organization or project.",
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
    path: "/v1/wallets",
    tags: ["Wallets"],
    summary: "List wallets",
    operationId: "listWallets",
    description: "Lists wallets for the active signing configuration.",
    security: [{ apiKeyAuth: [] }],
    request: {
      query: z.object({
        projectId: projectIdParamSchema.optional(),
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
    path: "/v1/wallets/public-key",
    tags: ["Wallets"],
    summary: "Get wallet public key",
    operationId: "getWalletPublicKey",
    description: "Returns the active wallet public key for transaction construction.",
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
}
