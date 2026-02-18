import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";

import {
  createConfidentialTransferRequestSchema,
  createTransferRequestSchema,
  errorResponseSchema,
  executeOfframpRequestSchema,
  executeOnrampRequestSchema,
  isoDateTimeSchema,
  offrampQuoteRequestSchema,
  onrampQuoteRequestSchema,
  pageQuerySchema,
  pageSizeQuerySchema,
  prepareTransferRequestSchema,
  transferDirectionSchema,
  transferIdParamSchema,
  transferStatusSchema,
  updateWalletPolicyRequestSchema,
  walletIdParamSchema,
} from "../schemas";
import { errorResponses, jsonContent } from "./helpers";
import {
  feeQuoteResponse,
  offrampExecutionResponse,
  offrampQuoteResponse,
  onrampExecutionResponse,
  onrampQuoteResponse,
  prepareTransferResponse,
  transferListResponse,
  transferResponse,
  walletBalancesResponse,
  walletPolicyResponse,
} from "./responses";

const draftNotice =
  "DRAFT: This endpoint is not implemented yet. It is provided for discussion and review only.";
const withDraft = (description: string) => `${draftNotice}\n\n${description}`;

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
      "Retrieves balances for a wallet. Wallet lifecycle and provisioning are managed through /v1/wallets.",
    security: [{ apiKeyAuth: [] }],
    request: {
      params: z.object({
        walletId: walletIdParamSchema,
      }),
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
      "Retrieves payment policy rules for a wallet. Policies are payment controls layered on top of wallet-managed accounts.",
    security: [{ apiKeyAuth: [] }],
    request: {
      params: z.object({
        walletId: walletIdParamSchema,
      }),
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
      "Updates payment policy rules for a wallet. Wallet provisioning and default selection remain in /v1/wallets.",
    security: [{ apiKeyAuth: [] }],
    request: {
      params: z.object({
        walletId: walletIdParamSchema,
      }),
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
      "Builds an unsigned transfer transaction for a wallet. The source walletId must reference a wallet from /v1/wallets.",
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
    summary: "Execute transfer (wallet signing)",
    operationId: "createPaymentTransfer",
    description:
      "Executes a transfer using server-side wallet signing. The source walletId must reference a wallet from /v1/wallets.",
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
      query: z.object({
        wallet: z.string().optional().openapi({ description: "Filter by wallet ID." }),
        walletAddress: z
          .string()
          .optional()
          .openapi({ description: "Filter by an address owned by the authenticated scope." }),
        token: z.string().optional().openapi({ description: "Filter by token symbol or mint." }),
        direction: transferDirectionSchema
          .optional()
          .openapi({ description: "Filter by transfer direction." }),
        status: transferStatusSchema.optional(),
        from: isoDateTimeSchema.optional().openapi({ description: "Filter from timestamp." }),
        to: isoDateTimeSchema.optional().openapi({ description: "Filter to timestamp." }),
        page: pageQuerySchema.optional(),
        pageSize: pageSizeQuerySchema.optional(),
      }),
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
    method: "post",
    path: "/v1/payments/transfers/confidential",
    tags: ["Payments"],
    summary: "Create confidential transfer",
    operationId: "createConfidentialTransfer",
    description: withDraft("Creates a confidential transfer using Token-2022."),
    security: [{ apiKeyAuth: [] }],
    request: {
      body: {
        required: true,
        content: jsonContent(createConfidentialTransferRequestSchema),
      },
    },
    responses: {
      200: {
        description: "Confidential transfer executed",
        content: jsonContent(transferResponse),
      },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 500]),
    },
  });

  registry.registerPath({
    method: "get",
    path: "/v1/payments/transfers/{transferId}",
    tags: ["Payments"],
    summary: "Get transfer",
    operationId: "getPaymentTransfer",
    description:
      "Retrieves transfer details by on-chain signature, or by pending SDP transfer id (`xfr_*`).",
    security: [{ apiKeyAuth: [] }],
    request: {
      params: z.object({
        transferId: transferIdParamSchema,
      }),
    },
    responses: {
      200: {
        description: "Transfer details",
        content: jsonContent(transferResponse),
      },
      ...errorResponses(errorResponseSchema, [401, 403, 404, 500]),
    },
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Fees
  // ═══════════════════════════════════════════════════════════════════════════

  registry.registerPath({
    method: "get",
    path: "/v1/payments/fees/quote",
    tags: ["Payments"],
    summary: "Get fee quote",
    operationId: "getPaymentFeeQuote",
    description: withDraft("Retrieves a fee quote for a transfer."),
    security: [{ apiKeyAuth: [] }],
    request: {
      query: z.object({
        token: z.string().openapi({ description: "Fee token symbol or mint address." }),
      }),
    },
    responses: {
      200: {
        description: "Fee quote",
        content: jsonContent(feeQuoteResponse),
      },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 500]),
    },
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Ramps
  // ═══════════════════════════════════════════════════════════════════════════

  registry.registerPath({
    method: "post",
    path: "/v1/payments/ramps/onramp/quote",
    tags: ["Payments"],
    summary: "Get on-ramp quote",
    operationId: "getPaymentOnrampQuote",
    description: withDraft("Retrieves a fiat-to-crypto on-ramp quote."),
    security: [{ apiKeyAuth: [] }],
    request: {
      body: {
        required: true,
        content: jsonContent(onrampQuoteRequestSchema),
      },
    },
    responses: {
      200: {
        description: "On-ramp quote",
        content: jsonContent(onrampQuoteResponse),
      },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 500]),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/v1/payments/ramps/onramp/execute",
    tags: ["Payments"],
    summary: "Execute on-ramp",
    operationId: "executePaymentOnramp",
    description: withDraft("Executes a fiat-to-crypto on-ramp transaction."),
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
    path: "/v1/payments/ramps/offramp/quote",
    tags: ["Payments"],
    summary: "Get off-ramp quote",
    operationId: "getPaymentOfframpQuote",
    description: withDraft("Retrieves a crypto-to-fiat off-ramp quote."),
    security: [{ apiKeyAuth: [] }],
    request: {
      body: {
        required: true,
        content: jsonContent(offrampQuoteRequestSchema),
      },
    },
    responses: {
      200: {
        description: "Off-ramp quote",
        content: jsonContent(offrampQuoteResponse),
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
    description: withDraft("Executes a crypto-to-fiat off-ramp transaction."),
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
}
