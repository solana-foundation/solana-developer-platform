import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";

import {
  createOnrampQuoteRequestSchema,
  createRecurringPaymentRequestSchema,
  createSubscriptionCollectionAttemptRequestSchema,
  createSubscriptionPlanRequestSchema,
  createSubscriptionRequestSchema,
  createTransferBatchRequestSchema,
  createTransferRequestSchema,
  errorResponseSchema,
  estimateTransferBatchRequestSchema,
  executeOfframpRequestSchema,
  executeOnrampRequestSchema,
  paymentListRecurringPaymentsQuerySchema,
  paymentListSubscriptionCollectionAttemptsQuerySchema,
  paymentListSubscriptionPlansQuerySchema,
  paymentListSubscriptionsQuerySchema,
  paymentListTransferBatchesQuerySchema,
  paymentListTransfersQuerySchema,
  paymentOfframpCurrenciesQuerySchema,
  paymentOnrampCurrenciesQuerySchema,
  paymentRecurringPaymentIdParamsSchema,
  paymentSubscriptionIdParamsSchema,
  paymentSubscriptionPlanIdParamsSchema,
  paymentTransferBatchIdParamsSchema,
  paymentTransferIdParamsSchema,
  paymentWalletIdParamsSchema,
  prepareSubscriptionAuthorizationRequestSchema,
  prepareSubscriptionCollectionRequestSchema,
  prepareSubscriptionLifecycleRequestSchema,
  prepareSubscriptionPlanCreateRequestSchema,
  prepareTransferRequestSchema,
  simulateSandboxTransferRequestSchema,
  updateRecurringPaymentRequestSchema,
  updateSubscriptionPlanRequestSchema,
  updateSubscriptionRequestSchema,
  updateWalletPolicyRequestSchema,
} from "../schemas";
import { errorResponses, jsonContent, projectScopeHeaders } from "./helpers";
import {
  offrampCurrenciesResponse,
  offrampExecutionResponse,
  onrampCurrenciesResponse,
  onrampExecutionResponse,
  onrampQuoteResponse,
  paymentRecurringPaymentCollectionResponse,
  paymentRecurringPaymentListResponse,
  paymentRecurringPaymentResponse,
  paymentSubscriptionCollectionAttemptListResponse,
  paymentSubscriptionCollectionAttemptResponse,
  paymentSubscriptionListResponse,
  paymentSubscriptionPlanListResponse,
  paymentSubscriptionPlanResponse,
  paymentSubscriptionResponse,
  preparePaymentSubscriptionAuthorizationResponse,
  preparePaymentSubscriptionCollectionResponse,
  preparePaymentSubscriptionLifecycleResponse,
  preparePaymentSubscriptionPlanResponse,
  prepareTransferResponse,
  sandboxTransferSimulationResponse,
  transferBatchEstimateResponse,
  transferBatchListResponse,
  transferBatchResponse,
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
      headers: projectScopeHeaders,
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
      headers: projectScopeHeaders,
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
      headers: projectScopeHeaders,
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
      headers: projectScopeHeaders,
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
      headers: projectScopeHeaders,
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
      headers: projectScopeHeaders,
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
      headers: projectScopeHeaders,
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
    path: "/v1/payments/transfer-batches/estimate",
    tags: ["Payments"],
    summary: "Estimate transfer batch",
    operationId: "estimatePaymentTransferBatch",
    description:
      "Validates a transfer batch request and estimates transaction chunking and fees. This route is scaffolded; estimation is not implemented yet.",
    security: [{ apiKeyAuth: [] }],
    request: {
      headers: projectScopeHeaders,
      body: {
        required: true,
        content: jsonContent(estimateTransferBatchRequestSchema),
      },
    },
    responses: {
      200: {
        description: "Transfer batch estimate",
        content: jsonContent(transferBatchEstimateResponse),
      },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 404, 500]),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/v1/payments/transfer-batches",
    tags: ["Payments"],
    summary: "Create transfer batch",
    operationId: "createPaymentTransferBatch",
    description:
      "Creates a custody-executed outbound transfer batch to counterparty crypto-wallet accounts. This route is scaffolded; execution is not implemented yet.",
    security: [{ apiKeyAuth: [] }],
    request: {
      headers: projectScopeHeaders,
      body: {
        required: true,
        content: jsonContent(createTransferBatchRequestSchema),
      },
    },
    responses: {
      200: {
        description: "Transfer batch created",
        content: jsonContent(transferBatchResponse),
      },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 404, 500]),
    },
  });

  registry.registerPath({
    method: "get",
    path: "/v1/payments/transfer-batches",
    tags: ["Payments"],
    summary: "List transfer batches",
    operationId: "listPaymentTransferBatches",
    description: "Lists transfer batches for the authenticated organization or project scope.",
    security: [{ apiKeyAuth: [] }],
    request: {
      headers: projectScopeHeaders,
      query: paymentListTransferBatchesQuerySchema,
    },
    responses: {
      200: {
        description: "Transfer batch list",
        content: jsonContent(transferBatchListResponse),
      },
      ...errorResponses(errorResponseSchema, [401, 403, 500]),
    },
  });

  registry.registerPath({
    method: "get",
    path: "/v1/payments/transfer-batches/{batchId}",
    tags: ["Payments"],
    summary: "Get transfer batch",
    operationId: "getPaymentTransferBatch",
    description: "Retrieves a transfer batch with recipient rows and chunk transfer summaries.",
    security: [{ apiKeyAuth: [] }],
    request: {
      headers: projectScopeHeaders,
      params: paymentTransferBatchIdParamsSchema,
    },
    responses: {
      200: {
        description: "Transfer batch details",
        content: jsonContent(transferBatchResponse),
      },
      ...errorResponses(errorResponseSchema, [401, 403, 404, 500]),
    },
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Recurring Payments (feature-flagged)
  // ═══════════════════════════════════════════════════════════════════════════

  registry.registerPath({
    method: "post",
    path: "/v1/payments/recurring-payments",
    tags: ["Payments"],
    summary: "Create recurring payment",
    operationId: "createPaymentRecurringPayment",
    description:
      "Creates an SDP-custody outbound recurring payment intent from a custody wallet to a counterparty crypto-wallet account. This stores backend state only; activation and collection are added by follow-up endpoints.",
    security: [{ apiKeyAuth: [] }],
    request: {
      headers: projectScopeHeaders,
      body: {
        required: true,
        content: jsonContent(createRecurringPaymentRequestSchema),
      },
    },
    responses: {
      201: {
        description: "Recurring payment created",
        content: jsonContent(paymentRecurringPaymentResponse),
      },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 404, 500]),
    },
  });

  registry.registerPath({
    method: "get",
    path: "/v1/payments/recurring-payments",
    tags: ["Payments"],
    summary: "List recurring payments",
    operationId: "listPaymentRecurringPayments",
    description:
      "Lists SDP-custody outbound recurring payments for the authenticated organization or project scope.",
    security: [{ apiKeyAuth: [] }],
    request: {
      headers: projectScopeHeaders,
      query: paymentListRecurringPaymentsQuerySchema,
    },
    responses: {
      200: {
        description: "Recurring payment list",
        content: jsonContent(paymentRecurringPaymentListResponse),
      },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 500]),
    },
  });

  registry.registerPath({
    method: "patch",
    path: "/v1/payments/recurring-payments/{id}",
    tags: ["Payments"],
    summary: "Update recurring payment",
    operationId: "updatePaymentRecurringPayment",
    description:
      "Updates an SDP-custody recurring payment. Pending records are updated directly. Active metadata and due-date edits are applied in place, while active term, source, destination, or token edits create a replacement Solana subscription, authorize it, cancel the old subscription, and then swap the recurring payment to the replacement records.",
    security: [{ apiKeyAuth: [] }],
    request: {
      headers: projectScopeHeaders,
      params: paymentRecurringPaymentIdParamsSchema,
      body: {
        required: true,
        content: jsonContent(updateRecurringPaymentRequestSchema),
      },
    },
    responses: {
      200: {
        description: "Recurring payment updated",
        content: jsonContent(paymentRecurringPaymentResponse),
      },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 404, 409, 500]),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/v1/payments/recurring-payments/{id}/activate",
    tags: ["Payments"],
    summary: "Activate recurring payment",
    operationId: "activatePaymentRecurringPayment",
    description:
      "Activates a pending SDP-custody recurring payment by creating the Solana subscriptions plan, authorizing the subscription, and storing the resulting on-chain identifiers and signatures.",
    security: [{ apiKeyAuth: [] }],
    request: {
      headers: projectScopeHeaders,
      params: paymentRecurringPaymentIdParamsSchema,
    },
    responses: {
      200: {
        description: "Recurring payment activated",
        content: jsonContent(paymentRecurringPaymentResponse),
      },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 404, 409, 500]),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/v1/payments/recurring-payments/{id}/cancel",
    tags: ["Payments"],
    summary: "Cancel recurring payment",
    operationId: "cancelPaymentRecurringPayment",
    description:
      "Cancels an active SDP-custody recurring payment by submitting the Solana subscriptions cancellation transaction and storing the resulting lifecycle state.",
    security: [{ apiKeyAuth: [] }],
    request: {
      headers: projectScopeHeaders,
      params: paymentRecurringPaymentIdParamsSchema,
    },
    responses: {
      200: {
        description: "Recurring payment canceled",
        content: jsonContent(paymentRecurringPaymentResponse),
      },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 404, 409, 500]),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/v1/payments/recurring-payments/{id}/collect",
    tags: ["Payments"],
    summary: "Collect recurring payment",
    operationId: "collectPaymentRecurringPayment",
    description:
      "Manually collects a due active SDP-custody recurring payment by submitting the Solana subscriptions collection transaction, creating a linked payment transfer, recording the collection attempt, and advancing the next due time.",
    security: [{ apiKeyAuth: [] }],
    request: {
      headers: projectScopeHeaders,
      params: paymentRecurringPaymentIdParamsSchema,
    },
    responses: {
      200: {
        description: "Recurring payment collected",
        content: jsonContent(paymentRecurringPaymentCollectionResponse),
      },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 404, 409, 500]),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/v1/payments/recurring-payments/{id}/resume",
    tags: ["Payments"],
    summary: "Resume recurring payment",
    operationId: "resumePaymentRecurringPayment",
    description:
      "Resumes a canceled SDP-custody recurring payment by submitting the Solana subscriptions resume transaction and restoring the recurring payment to active status.",
    security: [{ apiKeyAuth: [] }],
    request: {
      headers: projectScopeHeaders,
      params: paymentRecurringPaymentIdParamsSchema,
    },
    responses: {
      200: {
        description: "Recurring payment resumed",
        content: jsonContent(paymentRecurringPaymentResponse),
      },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 404, 409, 500]),
    },
  });

  registry.registerPath({
    method: "get",
    path: "/v1/payments/recurring-payments/{id}",
    tags: ["Payments"],
    summary: "Get recurring payment",
    operationId: "getPaymentRecurringPayment",
    description: "Retrieves an SDP-custody outbound recurring payment record.",
    security: [{ apiKeyAuth: [] }],
    request: {
      headers: projectScopeHeaders,
      params: paymentRecurringPaymentIdParamsSchema,
    },
    responses: {
      200: {
        description: "Recurring payment",
        content: jsonContent(paymentRecurringPaymentResponse),
      },
      ...errorResponses(errorResponseSchema, [401, 403, 404, 500]),
    },
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Recurring Subscriptions (feature-flagged)
  // ═══════════════════════════════════════════════════════════════════════════

  registry.registerPath({
    method: "post",
    path: "/v1/payments/subscription-plans",
    tags: ["Payments"],
    summary: "Create subscription plan",
    operationId: "createPaymentSubscriptionPlan",
    description:
      "Creates a feature-flagged recurring-payment subscription plan record. This stores SDP backend state and Solana subscriptions program identifiers; it does not by itself create the on-chain plan.",
    security: [{ apiKeyAuth: [] }],
    request: {
      headers: projectScopeHeaders,
      body: {
        required: true,
        content: jsonContent(createSubscriptionPlanRequestSchema),
      },
    },
    responses: {
      201: {
        description: "Subscription plan created",
        content: jsonContent(paymentSubscriptionPlanResponse),
      },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 404, 409, 500]),
    },
  });

  registry.registerPath({
    method: "get",
    path: "/v1/payments/subscription-plans",
    tags: ["Payments"],
    summary: "List subscription plans",
    operationId: "listPaymentSubscriptionPlans",
    description: "Lists feature-flagged recurring-payment subscription plans.",
    security: [{ apiKeyAuth: [] }],
    request: {
      headers: projectScopeHeaders,
      query: paymentListSubscriptionPlansQuerySchema,
    },
    responses: {
      200: {
        description: "Subscription plan list",
        content: jsonContent(paymentSubscriptionPlanListResponse),
      },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 500]),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/v1/payments/subscription-plans/{planId}/prepare-create",
    tags: ["Payments"],
    summary: "Prepare subscription plan creation",
    operationId: "preparePaymentSubscriptionPlanCreate",
    description:
      "Prepares an unsigned Solana subscriptions program create-plan transaction from an SDP subscription plan. This derives and stores the plan PDA but does not submit the transaction.",
    security: [{ apiKeyAuth: [] }],
    request: {
      headers: projectScopeHeaders,
      params: paymentSubscriptionPlanIdParamsSchema,
      body: {
        required: false,
        content: jsonContent(prepareSubscriptionPlanCreateRequestSchema),
      },
    },
    responses: {
      200: {
        description: "Subscription plan creation prepared",
        content: jsonContent(preparePaymentSubscriptionPlanResponse),
      },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 404, 500]),
    },
  });

  registry.registerPath({
    method: "get",
    path: "/v1/payments/subscription-plans/{planId}",
    tags: ["Payments"],
    summary: "Get subscription plan",
    operationId: "getPaymentSubscriptionPlan",
    description: "Retrieves a recurring-payment subscription plan record.",
    security: [{ apiKeyAuth: [] }],
    request: {
      headers: projectScopeHeaders,
      params: paymentSubscriptionPlanIdParamsSchema,
    },
    responses: {
      200: {
        description: "Subscription plan",
        content: jsonContent(paymentSubscriptionPlanResponse),
      },
      ...errorResponses(errorResponseSchema, [401, 403, 404, 500]),
    },
  });

  registry.registerPath({
    method: "patch",
    path: "/v1/payments/subscription-plans/{planId}",
    tags: ["Payments"],
    summary: "Update subscription plan",
    operationId: "updatePaymentSubscriptionPlan",
    description: "Updates mutable subscription plan fields and on-chain identifiers.",
    security: [{ apiKeyAuth: [] }],
    request: {
      headers: projectScopeHeaders,
      params: paymentSubscriptionPlanIdParamsSchema,
      body: {
        required: true,
        content: jsonContent(updateSubscriptionPlanRequestSchema),
      },
    },
    responses: {
      200: {
        description: "Subscription plan updated",
        content: jsonContent(paymentSubscriptionPlanResponse),
      },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 404, 500]),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/v1/payments/subscriptions",
    tags: ["Payments"],
    summary: "Create subscription",
    operationId: "createPaymentSubscription",
    description:
      "Creates a feature-flagged recurring-payment subscription record tied to a counterparty. The customer must still sign the Solana subscription authorization transaction.",
    security: [{ apiKeyAuth: [] }],
    request: {
      headers: projectScopeHeaders,
      body: {
        required: true,
        content: jsonContent(createSubscriptionRequestSchema),
      },
    },
    responses: {
      201: {
        description: "Subscription created",
        content: jsonContent(paymentSubscriptionResponse),
      },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 404, 409, 500]),
    },
  });

  registry.registerPath({
    method: "get",
    path: "/v1/payments/subscriptions",
    tags: ["Payments"],
    summary: "List subscriptions",
    operationId: "listPaymentSubscriptions",
    description: "Lists recurring-payment subscriptions.",
    security: [{ apiKeyAuth: [] }],
    request: {
      headers: projectScopeHeaders,
      query: paymentListSubscriptionsQuerySchema,
    },
    responses: {
      200: {
        description: "Subscription list",
        content: jsonContent(paymentSubscriptionListResponse),
      },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 500]),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/v1/payments/subscriptions/{subscriptionId}/prepare-authorization",
    tags: ["Payments"],
    summary: "Prepare subscription authorization",
    operationId: "preparePaymentSubscriptionAuthorization",
    description:
      "Prepares the subscriber-signed Solana transaction that initializes the subscription authority and subscribes to the plan. The transaction must still be signed and submitted by the client.",
    security: [{ apiKeyAuth: [] }],
    request: {
      headers: projectScopeHeaders,
      params: paymentSubscriptionIdParamsSchema,
      body: {
        required: true,
        content: jsonContent(prepareSubscriptionAuthorizationRequestSchema),
      },
    },
    responses: {
      200: {
        description: "Subscription authorization prepared",
        content: jsonContent(preparePaymentSubscriptionAuthorizationResponse),
      },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 404, 500]),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/v1/payments/subscriptions/{subscriptionId}/prepare-cancel",
    tags: ["Payments"],
    summary: "Prepare subscription cancellation",
    operationId: "preparePaymentSubscriptionCancel",
    description:
      "Prepares the subscriber-signed Solana transaction that cancels a subscription. The transaction must still be signed and submitted by the client.",
    security: [{ apiKeyAuth: [] }],
    request: {
      headers: projectScopeHeaders,
      params: paymentSubscriptionIdParamsSchema,
      body: {
        required: false,
        content: jsonContent(prepareSubscriptionLifecycleRequestSchema),
      },
    },
    responses: {
      200: {
        description: "Subscription cancellation prepared",
        content: jsonContent(preparePaymentSubscriptionLifecycleResponse),
      },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 404, 500]),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/v1/payments/subscriptions/{subscriptionId}/prepare-resume",
    tags: ["Payments"],
    summary: "Prepare subscription resume",
    operationId: "preparePaymentSubscriptionResume",
    description:
      "Prepares the subscriber-signed Solana transaction that resumes a canceled subscription before revocation. The transaction must still be signed and submitted by the client.",
    security: [{ apiKeyAuth: [] }],
    request: {
      headers: projectScopeHeaders,
      params: paymentSubscriptionIdParamsSchema,
      body: {
        required: false,
        content: jsonContent(prepareSubscriptionLifecycleRequestSchema),
      },
    },
    responses: {
      200: {
        description: "Subscription resume prepared",
        content: jsonContent(preparePaymentSubscriptionLifecycleResponse),
      },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 404, 500]),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/v1/payments/subscriptions/{subscriptionId}/prepare-collection",
    tags: ["Payments"],
    summary: "Prepare subscription collection",
    operationId: "preparePaymentSubscriptionCollection",
    description:
      "Prepares the collector-signed Solana subscriptions transfer transaction for an active subscription. The transaction must still be signed and submitted by the collector/fee-payer flow.",
    security: [{ apiKeyAuth: [] }],
    request: {
      headers: projectScopeHeaders,
      params: paymentSubscriptionIdParamsSchema,
      body: {
        required: true,
        content: jsonContent(prepareSubscriptionCollectionRequestSchema),
      },
    },
    responses: {
      200: {
        description: "Subscription collection prepared",
        content: jsonContent(preparePaymentSubscriptionCollectionResponse),
      },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 404, 500]),
    },
  });

  registry.registerPath({
    method: "get",
    path: "/v1/payments/subscriptions/{subscriptionId}",
    tags: ["Payments"],
    summary: "Get subscription",
    operationId: "getPaymentSubscription",
    description: "Retrieves a recurring-payment subscription record.",
    security: [{ apiKeyAuth: [] }],
    request: {
      headers: projectScopeHeaders,
      params: paymentSubscriptionIdParamsSchema,
    },
    responses: {
      200: {
        description: "Subscription",
        content: jsonContent(paymentSubscriptionResponse),
      },
      ...errorResponses(errorResponseSchema, [401, 403, 404, 500]),
    },
  });

  registry.registerPath({
    method: "patch",
    path: "/v1/payments/subscriptions/{subscriptionId}",
    tags: ["Payments"],
    summary: "Update subscription",
    operationId: "updatePaymentSubscription",
    description: "Updates mutable subscription status and on-chain identifiers.",
    security: [{ apiKeyAuth: [] }],
    request: {
      headers: projectScopeHeaders,
      params: paymentSubscriptionIdParamsSchema,
      body: {
        required: true,
        content: jsonContent(updateSubscriptionRequestSchema),
      },
    },
    responses: {
      200: {
        description: "Subscription updated",
        content: jsonContent(paymentSubscriptionResponse),
      },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 404, 500]),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/v1/payments/subscriptions/{subscriptionId}/collection-attempts",
    tags: ["Payments"],
    summary: "Create subscription collection attempt",
    operationId: "createPaymentSubscriptionCollectionAttempt",
    description:
      "Creates a collection-attempt record for a due recurring-payment subscription. Actual Solana settlement is owned by the collection worker/transaction submitter.",
    security: [{ apiKeyAuth: [] }],
    request: {
      headers: projectScopeHeaders,
      params: paymentSubscriptionIdParamsSchema,
      body: {
        required: true,
        content: jsonContent(createSubscriptionCollectionAttemptRequestSchema),
      },
    },
    responses: {
      201: {
        description: "Collection attempt created",
        content: jsonContent(paymentSubscriptionCollectionAttemptResponse),
      },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 404, 500]),
    },
  });

  registry.registerPath({
    method: "get",
    path: "/v1/payments/subscriptions/{subscriptionId}/collection-attempts",
    tags: ["Payments"],
    summary: "List subscription collection attempts",
    operationId: "listPaymentSubscriptionCollectionAttempts",
    description: "Lists collection attempts for a recurring-payment subscription.",
    security: [{ apiKeyAuth: [] }],
    request: {
      headers: projectScopeHeaders,
      params: paymentSubscriptionIdParamsSchema,
      query: paymentListSubscriptionCollectionAttemptsQuerySchema,
    },
    responses: {
      200: {
        description: "Collection attempt list",
        content: jsonContent(paymentSubscriptionCollectionAttemptListResponse),
      },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 404, 500]),
    },
  });

  registry.registerPath({
    method: "get",
    path: "/v1/payments/ramps/onramp/currency",
    tags: ["Payments"],
    summary: "List on-ramp currency support",
    operationId: "listPaymentOnrampCurrencies",
    description:
      "Lists generated fiat-to-crypto on-ramp pairs and the providers that support each pair. Supports optional source, destination rail, and provider filters.",
    security: [{ apiKeyAuth: [] }],
    request: {
      headers: projectScopeHeaders,
      query: paymentOnrampCurrenciesQuerySchema,
    },
    responses: {
      200: {
        description: "On-ramp currency support",
        content: jsonContent(onrampCurrenciesResponse),
      },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 500]),
    },
  });

  registry.registerPath({
    method: "get",
    path: "/v1/payments/ramps/offramp/currency",
    tags: ["Payments"],
    summary: "List off-ramp currency support",
    operationId: "listPaymentOfframpCurrencies",
    description:
      "Lists generated crypto-to-fiat off-ramp pairs and the providers that support each pair. Supports optional source rail, destination fiat, and provider filters.",
    security: [{ apiKeyAuth: [] }],
    request: {
      headers: projectScopeHeaders,
      query: paymentOfframpCurrenciesQuerySchema,
    },
    responses: {
      200: {
        description: "Off-ramp currency support",
        content: jsonContent(offrampCurrenciesResponse),
      },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 500]),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/v1/payments/ramps/onramp/quote",
    tags: ["Payments"],
    summary: "Create on-ramp quote",
    operationId: "createPaymentOnrampQuote",
    description:
      "Creates a provider-specific on-ramp quote. Hosted providers return a hosted URL; instruction-based providers return manual funding instructions.",
    security: [{ apiKeyAuth: [] }],
    request: {
      body: {
        required: true,
        content: jsonContent(createOnrampQuoteRequestSchema),
      },
    },
    responses: {
      200: {
        description: "On-ramp quote created",
        content: jsonContent(onrampQuoteResponse),
      },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 404, 500]),
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
      headers: projectScopeHeaders,
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
      headers: projectScopeHeaders,
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
      headers: projectScopeHeaders,
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
