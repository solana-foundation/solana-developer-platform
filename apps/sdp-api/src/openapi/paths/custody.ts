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
    path: "/v1/custody/initialize",
    tags: ["Custody"],
    summary: "Initialize custody",
    operationId: "initializeCustody",
    description:
      "Initializes custody for the organization or project by creating an active signing configuration.",
    security: [{ apiKeyAuth: [] }],
    request: {
      body: {
        required: true,
        content: jsonContent(initializeSigningRequestSchema),
      },
    },
    responses: {
      201: {
        description: "Custody initialized",
        content: jsonContent(initializeSigningResponseSchema),
      },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 409, 500]),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/v1/custody/switch",
    tags: ["Custody"],
    summary: "Switch custody provider",
    operationId: "switchCustodyProvider",
    description:
      "Switches the active custody provider for the organization or project without rotating existing on-chain authorities.",
    security: [{ apiKeyAuth: [] }],
    request: {
      body: {
        required: true,
        content: jsonContent(switchSigningRequestSchema),
      },
    },
    responses: {
      201: {
        description: "Custody provider switched",
        content: jsonContent(initializeSigningResponseSchema),
      },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 500]),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/v1/custody/wallets",
    tags: ["Custody"],
    summary: "Create custody wallet",
    operationId: "createCustodyWallet",
    description: "Provisions a new wallet for the active custody provider configuration.",
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
    path: "/v1/custody/default-wallet",
    tags: ["Custody"],
    summary: "Set default custody wallet",
    operationId: "setDefaultCustodyWallet",
    description: "Sets the default wallet for the active custody configuration.",
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
    path: "/v1/custody/config",
    tags: ["Custody"],
    summary: "Get custody config",
    operationId: "getCustodyConfig",
    description: "Returns the active custody configuration for the organization or project.",
    security: [{ apiKeyAuth: [] }],
    request: {
      query: z.object({
        projectId: projectIdParamSchema.optional(),
      }),
    },
    responses: {
      200: {
        description: "Custody config",
        content: jsonContent(custodyConfigResponse),
      },
      ...errorResponses(errorResponseSchema, [401, 403, 404, 500]),
    },
  });

  registry.registerPath({
    method: "get",
    path: "/v1/custody/wallets",
    tags: ["Custody"],
    summary: "List custody wallets",
    operationId: "listCustodyWallets",
    description: "Lists wallets for the active custody configuration.",
    security: [{ apiKeyAuth: [] }],
    request: {
      query: z.object({
        projectId: projectIdParamSchema.optional(),
      }),
    },
    responses: {
      200: {
        description: "Custody wallets",
        content: jsonContent(custodyWalletsResponse),
      },
      ...errorResponses(errorResponseSchema, [401, 403, 500]),
    },
  });

  registry.registerPath({
    method: "get",
    path: "/v1/custody/public-key",
    tags: ["Custody"],
    summary: "Get custody public key",
    operationId: "getCustodyPublicKey",
    description: "Returns the active custody public key for transaction construction.",
    security: [{ apiKeyAuth: [] }],
    request: {
      query: z.object({
        projectId: projectIdParamSchema.optional(),
        walletId: walletIdParamSchema.optional(),
      }),
    },
    responses: {
      200: {
        description: "Custody public key",
        content: jsonContent(custodyPublicKeyResponseSchema),
      },
      ...errorResponses(errorResponseSchema, [401, 403, 404, 500]),
    },
  });
}
