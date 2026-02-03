import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";

import {
  createConfidentialTransferRequestSchema,
  createPaymentRequestRequestSchema,
  createTransferRequestSchema,
  createWalletRequestSchema,
  cursorQuerySchema,
  errorResponseSchema,
  executeRampRequestSchema,
  isoDateTimeSchema,
  limitQuerySchema,
  paymentRequestIdParamSchema,
  prepareTransferRequestSchema,
  rampQuoteRequestSchema,
  transferIdParamSchema,
  transferStatusSchema,
  walletIdParamSchema,
  walletTypeSchema,
} from "../schemas";
import { errorResponses, jsonContent } from "./helpers";
import {
  feeQuoteResponse,
  listTransfersResponse,
  listWalletsResponse,
  paymentRequestResponse,
  prepareTransferResponse,
  rampExecutionResponse,
  rampQuoteResponse,
  transferResponse,
  walletBalancesResponse,
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
        limit: limitQuerySchema.optional(),
        cursor: cursorQuerySchema.optional(),
      }),
    },
    responses: {
      200: {
        description: "Wallet list",
        content: jsonContent(listWalletsResponse),
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

  // ═══════════════════════════════════════════════════════════════════════════
  // Transfers
  // ═══════════════════════════════════════════════════════════════════════════

  registry.registerPath({
    method: "post",
    path: "/v1/payments/transfers/prepare",
    tags: ["Payments"],
    summary: "Prepare transfer (unsigned)",
    operationId: "preparePaymentTransfer",
    description: withDraft(
      "Builds an unsigned transfer transaction for user-managed signing."
    ),
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
        token: z
          .string()
          .optional()
          .openapi({ description: "Filter by token symbol or mint." }),
        status: transferStatusSchema.optional(),
        from: isoDateTimeSchema.optional().openapi({ description: "Filter from timestamp." }),
        to: isoDateTimeSchema.optional().openapi({ description: "Filter to timestamp." }),
        limit: limitQuerySchema.optional(),
        cursor: cursorQuerySchema.optional(),
      }),
    },
    responses: {
      200: {
        description: "Transfer list",
        content: jsonContent(listTransfersResponse),
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
        amount: z.string().openapi({ description: "Transfer amount." }),
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
    path: "/v1/payments/ramps/quote",
    tags: ["Payments"],
    summary: "Get ramp quote",
    operationId: "getPaymentRampQuote",
    description: withDraft("Retrieves a fiat on/off-ramp quote."),
    security: [{ apiKeyAuth: [] }],
    request: {
      body: {
        required: true,
        content: jsonContent(rampQuoteRequestSchema),
      },
    },
    responses: {
      200: {
        description: "Ramp quote",
        content: jsonContent(rampQuoteResponse),
      },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 500]),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/v1/payments/ramps/execute",
    tags: ["Payments"],
    summary: "Execute ramp",
    operationId: "executePaymentRamp",
    description: withDraft("Executes a fiat on/off-ramp transaction."),
    security: [{ apiKeyAuth: [] }],
    request: {
      body: {
        required: true,
        content: jsonContent(executeRampRequestSchema),
      },
    },
    responses: {
      200: {
        description: "Ramp execution initiated",
        content: jsonContent(rampExecutionResponse),
      },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 500]),
    },
  });
}
