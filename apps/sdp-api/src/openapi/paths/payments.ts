import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";
import { errorResponseSchema } from "@/openapi/schemas/base";

import {
  createOnrampQuoteRequestSchema,
  createRecurringPaymentRequestSchema,
  createSubscriptionPlanRequestSchema,
  createSubscriptionRequestSchema,
  createTransferBatchRequestSchema,
  createTransferRequestSchema,
  estimateTransferBatchRequestSchema,
  paymentListRecurringPaymentsQuerySchema,
  paymentListSubscriptionCollectionAttemptsQuerySchema,
  paymentListSubscriptionPlansQuerySchema,
  paymentListSubscriptionsQuerySchema,
  paymentListTransferBatchesQuerySchema,
  paymentListTransfersQuerySchema,
  paymentOfframpCurrenciesQuerySchema,
  paymentOnrampCurrenciesQuerySchema,
  paymentRecurringPaymentIdParamsSchema,
  paymentRequestIdParamsSchema,
  paymentSubscriptionIdParamsSchema,
  paymentSubscriptionPlanIdParamsSchema,
  paymentTransferBatchIdParamsSchema,
  paymentTransferIdParamsSchema,
  paymentWalletIdParamsSchema,
  prepareSubscriptionAuthorizationRequestSchema,
  prepareSubscriptionCollectionRequestSchema,
  prepareSubscriptionLifecycleRequestSchema,
  prepareSubscriptionPlanCreateRequestSchema,
  simulateSandboxTransferRequestSchema,
  updateRecurringPaymentRequestSchema,
  updateSubscriptionPlanRequestSchema,
} from "@/openapi/schemas/payments";
import { walletBalancesQuerySchema } from "@/routes/payments/wallet-balances/schemas";
import {
  DOCS_GROUP,
  errorResponses,
  jsonContent,
  projectScopeHeaders,
  projectScopeWithDeclaredIdempotencyHeaders,
} from "./helpers";
import {
  offrampCurrenciesResponse,
  onrampCurrenciesResponse,
  onrampQuoteResponse,
  paymentRecurringPaymentCollectionResponse,
  paymentRecurringPaymentListResponse,
  paymentRecurringPaymentResponse,
  paymentRequestResponse,
  paymentSubscriptionCollectionAttemptListResponse,
  paymentSubscriptionListResponse,
  paymentSubscriptionPlanListResponse,
  paymentSubscriptionPlanResponse,
  paymentSubscriptionResponse,
  preparePaymentSubscriptionAuthorizationResponse,
  preparePaymentSubscriptionCollectionResponse,
  preparePaymentSubscriptionLifecycleResponse,
  preparePaymentSubscriptionPlanResponse,
  transferBatchEstimateResponse,
  transferBatchListResponse,
  transferBatchResponse,
  transferListResponse,
  transferResponse,
  walletBalancesResponse,
} from "./responses";

/** Where each Payments operation sits in the API reference (`DOCS_GROUP`). */
export const PAYMENT_GROUPS = {
  balances: "Balances and transactions",
  transfers: "Transfers",
  transferBatches: "Transfer batches",
  recurringPayments: "Recurring payments",
  paymentRequests: "Payment requests",
  subscriptionPlans: "Subscription plans",
  subscriptions: "Subscriptions",
  ramps: "Ramps",
} as const;

// Each matches the route's `idempotent()` step (ADR 0009); spec.test.ts checks.
// Transfers and batches store any answer once their row is written.
const movementKeyHeaders = projectScopeWithDeclaredIdempotencyHeaders({
  key: "required",
  serverErrors: "rerun",
  recovery: "record",
  storesAnswerAfterRecord: true,
});
const keyRequiredRerunHeaders = projectScopeWithDeclaredIdempotencyHeaders({
  key: "required",
  serverErrors: "rerun",
  recovery: "record",
});
const keyAcceptedHeaders = projectScopeWithDeclaredIdempotencyHeaders({
  key: "accepted",
  serverErrors: "store",
});
const keyAcceptedRerunHeaders = projectScopeWithDeclaredIdempotencyHeaders({
  key: "accepted",
  serverErrors: "rerun",
});

export function registerPaymentsPaths(registry: OpenAPIRegistry) {
  // ═══════════════════════════════════════════════════════════════════════════
  // Wallet Controls (custody-backed)
  // ═══════════════════════════════════════════════════════════════════════════

  registry.registerPath({
    method: "get",
    path: "/v1/payments/wallets/{walletId}/balances",
    tags: ["Payments"],
    [DOCS_GROUP]: PAYMENT_GROUPS.balances,
    summary: "Get wallet balances",
    operationId: "getPaymentWalletBalances",
    description:
      "Retrieves balances for a custody wallet. If any SOL or SPL balance read fails, returns 503 instead of partial or zero balances. Optional minimumSlot requires confirmed account state at or after that Solana slot; the response acknowledges the bound in data.balanceReadContext.minimumSlot. Wallet lifecycle and provisioning are managed through /v1/wallets.",
    security: [{ apiKeyAuth: [] }],
    request: {
      headers: projectScopeHeaders,
      params: paymentWalletIdParamsSchema,
      query: walletBalancesQuerySchema,
    },
    responses: {
      200: {
        description: "Wallet balances",
        content: jsonContent(
          walletBalancesResponse.extend({
            data: walletBalancesResponse.shape.data.extend({
              balanceReadContext: z
                .object({
                  minimumSlot: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
                })
                .optional(),
            }),
          })
        ),
      },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 404, 409, 500, 503]),
    },
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Transfers
  // ═══════════════════════════════════════════════════════════════════════════

  registry.registerPath({
    method: "post",
    path: "/v1/payments/transfers",
    tags: ["Payments"],
    [DOCS_GROUP]: PAYMENT_GROUPS.transfers,
    summary: "Execute transfer (custody)",
    operationId: "createPaymentTransfer",
    description:
      "Executes an on-chain transfer using the exact SDP Wallet ID (`id` from `/v1/wallets`) and server-side custody signing. Requires an Idempotency-Key: a retry with the same key and request returns the original transfer instead of sending a second one. A 200 may return a processing transfer with its signature when broadcast or confirmation is still being reconciled; do not create a replacement transfer for that payment. A native SOL transfer is refused with 409 `AMOUNT_BELOW_RENT_MINIMUM`, before anything is written or sent, when it pays less than the rent-exempt minimum to an address with no account or would leave the source wallet holding more than nothing but less than the minimum.",
    security: [{ apiKeyAuth: [] }],
    request: {
      headers: movementKeyHeaders,
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
      ...errorResponses(errorResponseSchema, [400, 401, 403, 404, 409, 422, 500, 503]),
    },
  });

  registry.registerPath({
    method: "get",
    path: "/v1/payments/transfers",
    tags: ["Payments"],
    [DOCS_GROUP]: PAYMENT_GROUPS.transfers,
    summary: "List transfers",
    operationId: "listPaymentTransfers",
    description:
      "Lists persisted payment transfers for the authenticated scope. Set custodyWalletId to select one exact SDP wallet; observed address history is opt-in with includeObserved=true.",
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
      ...errorResponses(errorResponseSchema, [400, 401, 403, 404, 409, 500]),
    },
  });

  registry.registerPath({
    method: "get",
    path: "/v1/payments/transfers/{transferId}",
    tags: ["Payments"],
    [DOCS_GROUP]: PAYMENT_GROUPS.transfers,
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
    [DOCS_GROUP]: PAYMENT_GROUPS.transferBatches,
    summary: "Estimate transfer batch",
    operationId: "estimatePaymentTransferBatch",
    description:
      "Validates an exact-wallet transfer batch request and estimates transaction chunking and fees. `warnings` lists what would make the batch fail: a native SOL amount below the rent-exempt minimum sent to an address with no account, or a source wallet left below the minimum; create refuses those with 409 `AMOUNT_BELOW_RENT_MINIMUM`.",
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
    [DOCS_GROUP]: PAYMENT_GROUPS.transferBatches,
    summary: "Create transfer batch",
    operationId: "createPaymentTransferBatch",
    description:
      "Executes an outbound transfer batch from one exact SDP Wallet ID, chunks recipients into Solana transactions, and returns the batch, recipient, and transfer records. Requires an Idempotency-Key: a retry with the same key and request returns the original batch without another on-chain submission. Recipient order does not change the request. A native SOL batch is refused with 409 `AMOUNT_BELOW_RENT_MINIMUM`, before anything is written or sent, when a recipient whose address has no account gets less than the rent-exempt minimum (`details.recipientIndexes`) or the source wallet would be left holding more than nothing but less than the minimum (`details.sourceRemainder`).",
    security: [{ apiKeyAuth: [] }],
    request: {
      headers: movementKeyHeaders,
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
      ...errorResponses(errorResponseSchema, [400, 401, 403, 404, 409, 422, 500]),
    },
  });

  registry.registerPath({
    method: "get",
    path: "/v1/payments/transfer-batches",
    tags: ["Payments"],
    [DOCS_GROUP]: PAYMENT_GROUPS.transferBatches,
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
      ...errorResponses(errorResponseSchema, [400, 401, 403, 404, 409, 500]),
    },
  });

  registry.registerPath({
    method: "get",
    path: "/v1/payments/transfer-batches/{batchId}",
    tags: ["Payments"],
    [DOCS_GROUP]: PAYMENT_GROUPS.transferBatches,
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

  registry.registerPath({
    method: "post",
    path: "/v1/payments/recurring-payments",
    tags: ["Payments"],
    [DOCS_GROUP]: PAYMENT_GROUPS.recurringPayments,
    summary: "Create recurring payment",
    operationId: "createPaymentRecurringPayment",
    description:
      "Creates an SDP-custody outbound recurring payment intent from a custody wallet to a counterparty crypto-wallet account. This stores backend state only; activation and collection are added by follow-up endpoints.",
    security: [{ apiKeyAuth: [] }],
    request: {
      headers: keyRequiredRerunHeaders,
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
      ...errorResponses(errorResponseSchema, [400, 401, 403, 404, 409, 422, 500]),
    },
  });

  registry.registerPath({
    method: "get",
    path: "/v1/payments/recurring-payments",
    tags: ["Payments"],
    [DOCS_GROUP]: PAYMENT_GROUPS.recurringPayments,
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
    [DOCS_GROUP]: PAYMENT_GROUPS.recurringPayments,
    summary: "Update recurring payment",
    operationId: "updatePaymentRecurringPayment",
    description:
      "Updates an SDP-custody recurring payment. Pending records are updated directly. Active metadata and due-date edits are applied in place, while active term, source, destination, or token edits create a replacement Solana subscription, authorize it, cancel the old subscription, and then swap the recurring payment to the replacement records. Requires an Idempotency-Key, because an edit can sign and broadcast a replacement subscription. A same-key retry of a completed edit replays its answer. A retry of an interrupted edit gets 409 IDEMPOTENCY_KEY_IN_FLIGHT with Retry-After until the attempt is stale, then resumes from the last step SDP recorded. If a step was sent but not yet recorded when the edit was interrupted, which is rare, the retry can fail or send that step again, so read the recurring payment with GET before editing it again.",
    security: [{ apiKeyAuth: [] }],
    request: {
      headers: keyRequiredRerunHeaders,
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
      ...errorResponses(errorResponseSchema, [400, 401, 403, 404, 409, 422, 500]),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/v1/payments/recurring-payments/{id}/activate",
    tags: ["Payments"],
    [DOCS_GROUP]: PAYMENT_GROUPS.recurringPayments,
    summary: "Activate recurring payment",
    operationId: "activatePaymentRecurringPayment",
    description:
      "Activates a pending SDP-custody recurring payment by creating the Solana subscriptions plan, authorizing the subscription, and storing the resulting on-chain identifiers and signatures.",
    security: [{ apiKeyAuth: [] }],
    request: {
      headers: keyRequiredRerunHeaders,
      params: paymentRecurringPaymentIdParamsSchema,
    },
    responses: {
      200: {
        description: "Recurring payment activated",
        content: jsonContent(paymentRecurringPaymentResponse),
      },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 404, 409, 422, 500]),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/v1/payments/recurring-payments/{id}/cancel",
    tags: ["Payments"],
    [DOCS_GROUP]: PAYMENT_GROUPS.recurringPayments,
    summary: "Cancel recurring payment",
    operationId: "cancelPaymentRecurringPayment",
    description:
      "Stops future collections for an active SDP-custody recurring payment by submitting the Solana subscriptions cancellation transaction. A collection already in processing may still settle independently.",
    security: [{ apiKeyAuth: [] }],
    request: {
      headers: keyRequiredRerunHeaders,
      params: paymentRecurringPaymentIdParamsSchema,
    },
    responses: {
      200: {
        description: "Recurring payment canceled",
        content: jsonContent(paymentRecurringPaymentResponse),
      },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 404, 409, 422, 500]),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/v1/payments/requests/{paymentRequestId}/cancel",
    tags: ["Payments"],
    [DOCS_GROUP]: PAYMENT_GROUPS.paymentRequests,
    summary: "Cancel payment request",
    operationId: "cancelPaymentRequest",
    description:
      "Cancels an open payment request, so its payment link stops building and sponsoring transactions. Requires `payment_requests.manage`. Canceling a request that is already canceled returns it unchanged. A paid or expired request returns 409, and so does one whose fee-sponsored transaction can still land: retry once that transaction's blockhash expires. A payer who signed before the cancel can still land the payment; SDP records it as paid, with `paidLate` set when it landed after the cancel.",
    security: [{ apiKeyAuth: [] }],
    request: {
      headers: keyAcceptedRerunHeaders,
      params: paymentRequestIdParamsSchema,
    },
    responses: {
      200: {
        description: "Payment request canceled",
        content: jsonContent(paymentRequestResponse),
      },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 404, 409, 422, 500, 502]),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/v1/payments/recurring-payments/{id}/collect",
    tags: ["Payments"],
    [DOCS_GROUP]: PAYMENT_GROUPS.recurringPayments,
    summary: "Collect recurring payment",
    operationId: "collectPaymentRecurringPayment",
    description:
      "Manually starts a due active SDP-custody recurring payment collection, creating a linked payment transfer and collection attempt. If submission cannot be confirmed immediately, a 200 response returns the same transfer as `processing` with its known signature; reconciliation settles it, and the next due time advances only after exact on-chain confirmation.",
    security: [{ apiKeyAuth: [] }],
    request: {
      headers: keyRequiredRerunHeaders,
      params: paymentRecurringPaymentIdParamsSchema,
    },
    responses: {
      200: {
        description: "Recurring payment collection result",
        content: jsonContent(paymentRecurringPaymentCollectionResponse),
      },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 404, 409, 422, 500]),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/v1/payments/recurring-payments/{id}/resume",
    tags: ["Payments"],
    [DOCS_GROUP]: PAYMENT_GROUPS.recurringPayments,
    summary: "Resume recurring payment",
    operationId: "resumePaymentRecurringPayment",
    description:
      "Resumes a canceled SDP-custody recurring payment by submitting the Solana subscriptions resume transaction and restoring the recurring payment to active status.",
    security: [{ apiKeyAuth: [] }],
    request: {
      headers: keyRequiredRerunHeaders,
      params: paymentRecurringPaymentIdParamsSchema,
    },
    responses: {
      200: {
        description: "Recurring payment resumed",
        content: jsonContent(paymentRecurringPaymentResponse),
      },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 404, 409, 422, 500]),
    },
  });

  registry.registerPath({
    method: "get",
    path: "/v1/payments/recurring-payments/{id}",
    tags: ["Payments"],
    [DOCS_GROUP]: PAYMENT_GROUPS.recurringPayments,
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

  registry.registerPath({
    method: "get",
    path: "/v1/payments/recurring-payments/{id}/collection-attempts",
    tags: ["Payments"],
    [DOCS_GROUP]: PAYMENT_GROUPS.recurringPayments,
    summary: "List recurring payment collection attempts",
    operationId: "listPaymentRecurringPaymentCollectionAttempts",
    description:
      "Lists collection attempts for a recurring payment's current subscription. A recurring payment that has not been activated has none.",
    security: [{ apiKeyAuth: [] }],
    request: {
      headers: projectScopeHeaders,
      params: paymentRecurringPaymentIdParamsSchema,
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
    method: "post",
    path: "/v1/payments/subscription-plans",
    tags: ["Payments"],
    [DOCS_GROUP]: PAYMENT_GROUPS.subscriptionPlans,
    summary: "Create subscription plan",
    operationId: "createPaymentSubscriptionPlan",
    description:
      "Creates a recurring-payment subscription plan record. This stores SDP backend state and Solana subscriptions program identifiers; it does not by itself create the on-chain plan.",
    security: [{ apiKeyAuth: [] }],
    request: {
      headers: keyAcceptedHeaders,
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
      ...errorResponses(errorResponseSchema, [400, 401, 403, 404, 409, 422, 500]),
    },
  });

  registry.registerPath({
    method: "get",
    path: "/v1/payments/subscription-plans",
    tags: ["Payments"],
    [DOCS_GROUP]: PAYMENT_GROUPS.subscriptionPlans,
    summary: "List subscription plans",
    operationId: "listPaymentSubscriptionPlans",
    description: "Lists recurring-payment subscription plans.",
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
    [DOCS_GROUP]: PAYMENT_GROUPS.subscriptionPlans,
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
    [DOCS_GROUP]: PAYMENT_GROUPS.subscriptionPlans,
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
    [DOCS_GROUP]: PAYMENT_GROUPS.subscriptionPlans,
    summary: "Update subscription plan",
    operationId: "updatePaymentSubscriptionPlan",
    description: "Updates mutable subscription plan fields and on-chain identifiers.",
    security: [{ apiKeyAuth: [] }],
    request: {
      headers: keyAcceptedHeaders,
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
      ...errorResponses(errorResponseSchema, [400, 401, 403, 404, 409, 422, 500]),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/v1/payments/subscriptions",
    tags: ["Payments"],
    [DOCS_GROUP]: PAYMENT_GROUPS.subscriptions,
    summary: "Create subscription",
    operationId: "createPaymentSubscription",
    description:
      "Creates a recurring-payment subscription record tied to a counterparty. The customer must still sign the Solana subscription authorization transaction.",
    security: [{ apiKeyAuth: [] }],
    request: {
      headers: keyAcceptedHeaders,
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
      ...errorResponses(errorResponseSchema, [400, 401, 403, 404, 409, 422, 500]),
    },
  });

  registry.registerPath({
    method: "get",
    path: "/v1/payments/subscriptions",
    tags: ["Payments"],
    [DOCS_GROUP]: PAYMENT_GROUPS.subscriptions,
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
    [DOCS_GROUP]: PAYMENT_GROUPS.subscriptions,
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
    [DOCS_GROUP]: PAYMENT_GROUPS.subscriptions,
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
    [DOCS_GROUP]: PAYMENT_GROUPS.subscriptions,
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
    [DOCS_GROUP]: PAYMENT_GROUPS.subscriptions,
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
    [DOCS_GROUP]: PAYMENT_GROUPS.subscriptions,
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
    method: "get",
    path: "/v1/payments/subscriptions/{subscriptionId}/collection-attempts",
    tags: ["Payments"],
    [DOCS_GROUP]: PAYMENT_GROUPS.subscriptions,
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
    [DOCS_GROUP]: PAYMENT_GROUPS.ramps,
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
    [DOCS_GROUP]: PAYMENT_GROUPS.ramps,
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
    [DOCS_GROUP]: PAYMENT_GROUPS.ramps,
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
      ...errorResponses(errorResponseSchema, [400, 401, 403, 404, 409, 429, 500, 502, 503]),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/v1/payments/ramps/sandbox/simulate",
    tags: ["Payments"],
    [DOCS_GROUP]: PAYMENT_GROUPS.ramps,
    summary: "Simulate sandbox transfer",
    operationId: "simulateSandboxTransfer",
    description:
      "Sandbox-only. Simulates the fiat pay-in for an on-ramp transfer awaiting payment, at most once per transfer.",
    security: [{ apiKeyAuth: [] }],
    request: {
      headers: projectScopeHeaders,
      body: {
        required: true,
        content: jsonContent(simulateSandboxTransferRequestSchema),
      },
    },
    responses: {
      204: { description: "Sandbox pay-in requested from the provider" },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 404, 409, 500, 503]),
    },
  });
}
