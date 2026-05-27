import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";

import {
  createTransferRequestSchema,
  errorResponseSchema,
  executeOfframpRequestSchema,
  executeOnrampRequestSchema,
  paymentListTransfersQuerySchema,
  paymentTransferIdParamsSchema,
  paymentWalletIdParamsSchema,
  prepareTransferRequestSchema,
  simulateSandboxTransferRequestSchema,
  updateWalletPolicyRequestSchema,
} from "../schemas";
import { errorResponses, jsonContent } from "./helpers";
import {
  offrampExecutionResponse,
  onrampExecutionResponse,
  prepareTransferResponse,
  sandboxTransferSimulationResponse,
  transferListResponse,
  transferResponse,
  walletBalancesResponse,
  walletPolicyResponse,
} from "./responses";

export function registerPaymentsPaths(registry: OpenAPIRegistry) {
  // ═══════════════════════════════════════════════════════════════════════════
  // Wallet Controls (custody-backed)
  // ═══════════════════════════════════════════════════════════════════════════

  registry.registerPath({
    method: "get",
    path: "/v1/payments/wallets/{walletId}/balances",
    tags: ["Payments"],
    summary: "Get wallet balances",
    operationId: "getPaymentWalletBalances",
    description:
      "Retrieves balances for a custody wallet. Wallet lifecycle and provisioning are managed through /v1/wallets.",
    security: [{ apiKeyAuth: [] }],
    request: {
      params: paymentWalletIdParamsSchema,
    },
    responses: {
      200: {
        description: "Wallet balances",
        content: jsonContent(walletBalancesResponse),
      },
      ...errorResponses(errorResponseSchema, [401, 403, 404, 500]),
    },
  });

  registry.registerPath({
    method: "get",
    path: "/v1/payments/wallets/{walletId}/policies",
    tags: ["Payments"],
    summary: "Get wallet policy",
    operationId: "getPaymentWalletPolicy",
    description:
      "Retrieves payment policy rules for a custody wallet. Policies are payment controls layered on top of custody-managed wallets.",
    security: [{ apiKeyAuth: [] }],
    request: {
      params: paymentWalletIdParamsSchema,
    },
    responses: {
      200: {
        description: "Wallet policy",
        content: jsonContent(walletPolicyResponse),
      },
      ...errorResponses(errorResponseSchema, [401, 403, 404, 500]),
    },
  });

  registry.registerPath({
    method: "put",
    path: "/v1/payments/wallets/{walletId}/policies",
    tags: ["Payments"],
    summary: "Update wallet policy",
    operationId: "updatePaymentWalletPolicy",
    description:
      "Updates payment policy rules for a custody wallet. Wallet provisioning and default selection remain in /v1/wallets.",
    security: [{ apiKeyAuth: [] }],
    request: {
      params: paymentWalletIdParamsSchema,
      body: {
        required: true,
        content: jsonContent(updateWalletPolicyRequestSchema),
      },
    },
    responses: {
      200: {
        description: "Wallet policy updated",
        content: jsonContent(walletPolicyResponse),
      },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 404, 500]),
    },
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Transfers
  // ═══════════════════════════════════════════════════════════════════════════

  registry.registerPath({
    method: "post",
    path: "/v1/payments/transfers/prepare",
    tags: ["Payments"],
    summary: "Prepare transfer (unsigned)",
    operationId: "preparePaymentTransfer",
    description:
      "Builds an unsigned transfer transaction for a custody wallet. The source walletId must reference a wallet from /v1/wallets. Private-transfer requests are provider-built here and returned for client review and signing.",
    security: [{ apiKeyAuth: [] }],
    request: {
      body: {
        required: true,
        content: jsonContent(prepareTransferRequestSchema),
      },
    },
    responses: {
      200: {
        description: "Transfer prepared",
        content: jsonContent(prepareTransferResponse),
      },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 500]),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/v1/payments/transfers",
    tags: ["Payments"],
    summary: "Execute transfer (custody)",
    operationId: "createPaymentTransfer",
    description:
      "Executes a transfer using server-side custody signing. The source walletId must reference a wallet from /v1/wallets. Private-transfer requests are provider-built, signed by SDP-controlled wallets when required, and submitted on the configured Solana cluster.",
    security: [{ apiKeyAuth: [] }],
    request: {
      body: {
        required: true,
        content: jsonContent(createTransferRequestSchema),
      },
    },
    responses: {
      200: {
        description: "Transfer executed",
        content: jsonContent(transferResponse),
      },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 500]),
    },
  });

  registry.registerPath({
    method: "get",
    path: "/v1/payments/transfers",
    tags: ["Payments"],
    summary: "List transfers",
    operationId: "listPaymentTransfers",
    description: "Lists payment transfers for the authenticated organization or project scope.",
    security: [{ apiKeyAuth: [] }],
    request: {
      query: paymentListTransfersQuerySchema,
    },
    responses: {
      200: {
        description: "Transfer list",
        content: jsonContent(transferListResponse),
      },
      ...errorResponses(errorResponseSchema, [401, 403, 500]),
    },
  });

  registry.registerPath({
    method: "get",
    path: "/v1/payments/transfers/{transferId}",
    tags: ["Payments"],
    summary: "Get transfer",
    operationId: "getPaymentTransfer",
    description: "Retrieves details for a specific transfer.",
    security: [{ apiKeyAuth: [] }],
    request: {
      params: paymentTransferIdParamsSchema,
    },
    responses: {
      200: {
        description: "Transfer details",
        content: jsonContent(transferResponse),
      },
      ...errorResponses(errorResponseSchema, [401, 403, 404, 500]),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/v1/payments/ramps/onramp/execute",
    tags: ["Payments"],
    summary: "Execute on-ramp",
    operationId: "executePaymentOnramp",
    description: "Creates a fiat-to-crypto on-ramp session through the selected provider.",
    security: [{ apiKeyAuth: [] }],
    request: {
      body: {
        required: true,
        content: jsonContent(executeOnrampRequestSchema),
      },
    },
    responses: {
      200: {
        description: "On-ramp execution initiated",
        content: jsonContent(onrampExecutionResponse),
      },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 500]),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/v1/payments/ramps/offramp/execute",
    tags: ["Payments"],
    summary: "Execute off-ramp",
    operationId: "executePaymentOfframp",
    description: "Creates a crypto-to-fiat off-ramp session through the selected provider.",
    security: [{ apiKeyAuth: [] }],
    request: {
      body: {
        required: true,
        content: jsonContent(executeOfframpRequestSchema),
      },
    },
    responses: {
      200: {
        description: "Off-ramp execution initiated",
        content: jsonContent(offrampExecutionResponse),
      },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 500]),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/v1/payments/ramps/sandbox/simulate",
    tags: ["Payments"],
    summary: "Simulate sandbox transfer",
    operationId: "simulateSandboxTransfer",
    description: "Sandbox-only helper that simulates provider-specific transfer completion flows.",
    security: [{ apiKeyAuth: [] }],
    request: {
      body: {
        required: true,
        content: jsonContent(simulateSandboxTransferRequestSchema),
      },
    },
    responses: {
      200: {
        description: "Sandbox transfer simulated",
        content: jsonContent(sandboxTransferSimulationResponse),
      },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 500]),
    },
  });
}
