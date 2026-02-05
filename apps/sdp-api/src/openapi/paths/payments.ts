import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";

import {
  createConfidentialTransferRequestSchema,
  createPaymentRequestRequestSchema,
  createTransferRequestSchema,
  createWalletRequestSchema,
  errorResponseSchema,
  executeOfframpRequestSchema,
  executeOnrampRequestSchema,
  isoDateTimeSchema,
  offrampQuoteRequestSchema,
  onrampQuoteRequestSchema,
  pageQuerySchema,
  pageSizeQuerySchema,
  paymentRequestIdParamSchema,
  prepareTransferRequestSchema,
  transferDirectionSchema,
  transferIdParamSchema,
  transferStatusSchema,
  updateWalletPolicyRequestSchema,
  walletIdParamSchema,
  walletTypeSchema,
} from "../schemas";
import { errorResponses, jsonContent } from "./helpers";
import {
  feeQuoteResponse,
  offrampExecutionResponse,
  offrampQuoteResponse,
  onrampExecutionResponse,
  onrampQuoteResponse,
  paymentRequestResponse,
  prepareTransferResponse,
  transferListResponse,
  transferResponse,
  walletBalancesResponse,
  walletListResponse,
  walletPolicyResponse,
  walletResponse,
} from "./responses";

const draftNotice =
  "DRAFT: This endpoint is not implemented yet. It is provided for discussion and review only.";
const withDraft = (description: string) => `${draftNotice}\n\n${description}`;

export function registerPaymentsPaths(registry: OpenAPIRegistry) {
  // ═══════════════════════════════════════════════════════════════════════════
  // Wallets
  // ═══════════════════════════════════════════════════════════════════════════

  registry.registerPath({
    method: "post",
    path: "/v1/payments/wallets",
    tags: ["Payments"],
    summary: "Create wallet",
    operationId: "createPaymentWallet",
    description: withDraft("Creates a new managed wallet for payments."),
    security: [{ apiKeyAuth: [] }],
    request: {
      body: {
        required: true,
        content: jsonContent(createWalletRequestSchema),
      },
    },
    responses: {
      201: {
        description: "Wallet created",
        content: jsonContent(walletResponse),
      },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 500]),
    },
  });

  registry.registerPath({
    method: "get",
    path: "/v1/payments/wallets",
    tags: ["Payments"],
    summary: "List wallets",
    operationId: "listPaymentWallets",
    description: withDraft("Lists all wallets for the organization."),
    security: [{ apiKeyAuth: [] }],
    request: {
      query: z.object({
        type: walletTypeSchema.optional(),
        page: pageQuerySchema.optional(),
        pageSize: pageSizeQuerySchema.optional(),
      }),
    },
    responses: {
      200: {
        description: "Wallet list",
        content: jsonContent(walletListResponse),
      },
      ...errorResponses(errorResponseSchema, [401, 403, 500]),
    },
  });

  registry.registerPath({
    method: "get",
    path: "/v1/payments/wallets/{walletId}",
    tags: ["Payments"],
    summary: "Get wallet",
    operationId: "getPaymentWallet",
    description: withDraft("Retrieves details for a specific wallet."),
    security: [{ apiKeyAuth: [] }],
    request: {
      params: z.object({
        walletId: walletIdParamSchema,
      }),
    },
    responses: {
      200: {
        description: "Wallet details",
        content: jsonContent(walletResponse),
      },
      ...errorResponses(errorResponseSchema, [401, 403, 404, 500]),
    },
  });

  registry.registerPath({
    method: "get",
    path: "/v1/payments/wallets/{walletId}/balances",
    tags: ["Payments"],
    summary: "Get wallet balances",
    operationId: "getPaymentWalletBalances",
    description: withDraft("Retrieves token balances for a wallet."),
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
    description: withDraft("Retrieves policy rules for a wallet."),
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
    description: withDraft("Updates policy rules for a wallet."),
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
    description: withDraft("Builds an unsigned transfer transaction for user-managed signing."),
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
    description: withDraft("Executes a transfer using server-side custody signing."),
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
    description: withDraft("Lists transfers for the organization."),
    security: [{ apiKeyAuth: [] }],
    request: {
      query: z.object({
        wallet: z.string().optional().openapi({ description: "Filter by wallet ID." }),
        walletAddress: z.string().optional().openapi({ description: "Filter by wallet address." }),
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
    description: withDraft("Retrieves details for a specific transfer."),
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
  // Payment Requests (Solana Pay)
  // ═══════════════════════════════════════════════════════════════════════════

  registry.registerPath({
    method: "post",
    path: "/v1/payments/requests",
    tags: ["Payments"],
    summary: "Create payment request",
    operationId: "createPaymentRequest",
    description: withDraft("Creates a Solana Pay payment request."),
    security: [{ apiKeyAuth: [] }],
    request: {
      body: {
        required: true,
        content: jsonContent(createPaymentRequestRequestSchema),
      },
    },
    responses: {
      201: {
        description: "Payment request created",
        content: jsonContent(paymentRequestResponse),
      },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 500]),
    },
  });

  registry.registerPath({
    method: "get",
    path: "/v1/payments/requests/{requestId}",
    tags: ["Payments"],
    summary: "Get payment request",
    operationId: "getPaymentRequest",
    description: withDraft("Retrieves details for a payment request."),
    security: [{ apiKeyAuth: [] }],
    request: {
      params: z.object({
        requestId: paymentRequestIdParamSchema,
      }),
    },
    responses: {
      200: {
        description: "Payment request details",
        content: jsonContent(paymentRequestResponse),
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
