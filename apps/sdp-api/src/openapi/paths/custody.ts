import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";

import { errorResponseSchema, walletIdParamSchema } from "@/openapi/schemas/base";
import {
  createCustodyWalletRequestSchema,
  custodyPublicKeyResponseSchema,
  deleteWalletRequestSchema,
  initializeSigningRequestSchema,
  initializeSigningResponseSchema,
  orgCustodyProviderSchema,
  signerCheckRequestSchema,
  updateCustodyWalletRequestSchema,
} from "@/openapi/schemas/custody";
import {
  errorResponses,
  jsonContent,
  projectScopeHeaders,
  projectScopeWithDeclaredIdempotencyHeaders,
} from "./helpers";
import {
  custodyConfigsResponse,
  custodyDeleteWalletResponse,
  custodySignerCheckResponse,
  custodyWalletAggregateResponse,
  custodyWalletByIdResponse,
  custodyWalletResponse,
  custodyWalletsResponse,
} from "./responses";

// Matches each route's `idempotent({ key: "accepted", serverErrors: "store" })`
// step (ADR 0009); spec.test.ts checks.
const keyAcceptedHeaders = projectScopeWithDeclaredIdempotencyHeaders({
  key: "accepted",
  serverErrors: "store",
});
// Wallet create also mounts `replayFromRecord`: `recovery: "record"`.
const walletCreateKeyHeaders = projectScopeWithDeclaredIdempotencyHeaders({
  key: "accepted",
  serverErrors: "store",
  recovery: "record",
});

export function registerCustodyPaths(registry: OpenAPIRegistry) {
  registry.registerPath({
    method: "post",
    path: "/v1/wallets/initialize",
    tags: ["Wallets"],
    summary: "Initialize wallet signing",
    operationId: "initializeWalletSigning",
    description:
      "Sets up Managed custody for the project's named provider by creating its active signing configuration and first wallet. Production projects use BYOK only: there this returns 403 with details.reason custody_mode_not_allowed, and wallets are created in a Custody Connection with POST /v1/wallets and connectionId.",
    security: [{ apiKeyAuth: [] }],
    request: {
      headers: keyAcceptedHeaders,
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
      ...errorResponses(errorResponseSchema, [400, 401, 404, 409, 422, 500]),
      403: {
        description:
          "Forbidden: the API key lacks permission or is wallet-scoped, or custody setup was refused. A refusal's details.reason names the failed check: custody_mode_not_allowed when a Production project names Managed custody (Production is BYOK only), custody_provider_not_in_release_channel, or provider_not_entitled.",
        content: jsonContent(errorResponseSchema),
      },
      503: {
        description:
          "PROVIDER_NOT_CONFIGURED: the deployment holds no credentials for the provider in the project's environment (details.reason provider_not_configured).",
        content: jsonContent(errorResponseSchema),
      },
    },
  });

  registry.registerPath({
    method: "post",
    path: "/v1/wallets",
    tags: ["Wallets"],
    summary: "Create wallet",
    operationId: "createWallet",
    description:
      "Provisions a new wallet under exactly one provider account: the project's Managed config for provider, or the Custody Connection named by connectionId. A body naming both, or neither, is rejected with 400. With an Idempotency-Key, SDP never records a second wallet for one key: a retry returns the wallet an earlier attempt recorded, including after the 24-hour key window. Privy and Coinbase CDP also receive a request id derived from the key, so they dedupe at the provider. A provider failure is stored as a 503, and a new key is a new provider request. A 503 can mean the provider created the wallet before the error, and with a provider other than Privy or Coinbase CDP, a failure that left no SDP wallet row makes even the same key a new provider request after 24 hours: before any retry after an ambiguous failure, whatever the key, check GET /v1/wallets and, if the wallet is not there, the provider account. The provider request id and the recorded-wallet lookup both include the credential, so after an API key rotation, once the key's 24-hour record has expired, the same key under the new credential is a new provider request and can create a second wallet: after a rotation, list wallets with GET /v1/wallets and check the provider account before retrying a create.",
    security: [{ apiKeyAuth: [] }],
    request: {
      headers: walletCreateKeyHeaders,
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
      ...errorResponses(errorResponseSchema, [400, 401, 404, 409, 422, 500, 503]),
      403: {
        description:
          "Forbidden: the API key lacks permission or is wallet-scoped, or the provider account was refused. A refusal's details.reason names the failed check: custody_mode_not_allowed when provider names a Managed config in a Production project (Production is BYOK only: create the wallet in a Custody Connection with connectionId), custody_provider_not_in_release_channel, or provider_not_entitled.",
        content: jsonContent(errorResponseSchema),
      },
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
      headers: keyAcceptedHeaders,
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
      ...errorResponses(errorResponseSchema, [400, 401, 403, 404, 409, 422, 500]),
    },
  });

  registry.registerPath({
    method: "get",
    path: "/v1/wallets/configs",
    tags: ["Wallets"],
    summary: "List wallet signing configs",
    operationId: "listWalletConfigs",
    description:
      "Returns the active Config-owned wallet signing configurations for the requested scope, one per provider.",
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
      "Lists active wallets under active Config and Connection owners, oldest first. Provider narrows the list to one custody provider.",
    security: [{ apiKeyAuth: [] }],
    request: {
      headers: projectScopeHeaders,
      query: z.object({
        provider: orgCustodyProviderSchema.optional(),
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
      "Aggregates tracked balances for active wallets under the same owner-aware inclusion rules as the wallet list, without exposing one aggregate-level owner or runtime-admission value. Returns 503 if any included wallet balance cannot be read, rather than returning an incomplete total.",
    security: [{ apiKeyAuth: [] }],
    request: {
      headers: projectScopeHeaders,
      query: z.object({
        provider: orgCustodyProviderSchema.optional(),
      }),
    },
    responses: {
      200: {
        description: "Aggregated wallet balances",
        content: jsonContent(custodyWalletAggregateResponse),
      },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 409, 500, 503]),
    },
  });

  registry.registerPath({
    method: "get",
    path: "/v1/wallets/public-key",
    tags: ["Wallets"],
    summary: "Get wallet public key",
    operationId: "getWalletPublicKey",
    description:
      "Returns the persisted public key for an exact active walletId. walletId may be omitted only by an API key whose own signing-wallet binding names the wallet; otherwise the request is rejected with 400. Resolution is DB-backed only.",
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
      ...errorResponses(errorResponseSchema, [400, 401, 403, 404, 409, 500]),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/v1/wallets/signer-check",
    tags: ["Wallets"],
    summary: "Check signer via simulated memo transaction",
    operationId: "checkWalletSigner",
    description:
      "Signs a server-authored memo message with the wallet selected by an authenticated API key or Clerk JWT, verifies the signature, and simulates the transaction. Nothing is broadcast and no sponsorship is spent. The wallet is the only readonly signer and the request cannot supply memo text.",
    security: [{ apiKeyAuth: [] }],
    request: {
      headers: keyAcceptedHeaders,
      body: {
        required: true,
        content: jsonContent(signerCheckRequestSchema),
      },
    },
    responses: {
      200: {
        description: "Signer check verified in simulation",
        content: jsonContent(custodySignerCheckResponse),
      },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 404, 409, 422, 429, 500, 502]),
    },
  });

  registry.registerPath({
    method: "get",
    path: "/v1/wallets/{walletId}",
    tags: ["Wallets"],
    summary: "Get wallet by ID",
    operationId: "getWalletById",
    description:
      "Returns active wallet metadata, exact Config or Connection ownership, runtime execution admission, Provider, public key, and by default the current SOL balance. If the balance read fails, returns 503 instead of a zero balance. Set includeBalance=false for a metadata-only read.",
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
      ...errorResponses(errorResponseSchema, [401, 403, 404, 409, 500, 503]),
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
      headers: keyAcceptedHeaders,
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
      ...errorResponses(errorResponseSchema, [400, 401, 403, 404, 409, 422, 500]),
    },
  });
}
