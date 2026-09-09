import { Hono } from "hono";
import { requirePermissions, unifiedAuthMiddleware } from "@/middleware/auth";
import { meteredQuota } from "@/middleware/metered-quota";
import { policyGate } from "@/middleware/policy-gate";
import { projectContextMiddleware } from "@/middleware/project-context";
import { validateBody } from "@/middleware/validate";
import type { Env } from "@/types/env";
import {
  activateRecurringPayment,
  admitTransferBatchRuntimeExecution,
  admitTransferRuntimeExecution,
  cancelRampTransfer,
  cancelRecurringPayment,
  collectRecurringPayment,
  createOfframpQuote,
  createOnrampQuote,
  createPaymentRequest,
  createRecurringPayment,
  createSubscription,
  createSubscriptionPlan,
  createTransfer,
  createTransferBatch,
  estimateOfframp,
  estimateOnramp,
  estimateTransferBatch,
  extractOfframpQuotePolicyCandidate,
  extractOnrampQuotePolicyCandidate,
  extractTransferBatchPolicyCandidate,
  extractTransferPolicyCandidate,
  findTransferBatchIdempotentKeyReplay,
  findTransferIdempotentKeyReplay,
  getRecurringPayment,
  getSubscription,
  getSubscriptionPlan,
  getTransfer,
  getTransferBatch,
  getWalletBalances,
  getWalletPolicy,
  getWalletPolicyEvaluation,
  listOfframpCurrencies,
  listOnrampCurrencies,
  listPaymentRequests,
  listRecurringPayments,
  listSubscriptionCollectionAttempts,
  listSubscriptionPlans,
  listSubscriptions,
  listTransferBatches,
  listTransfers,
  listWalletControlProfileRevisions,
  listWalletPolicyEvaluations,
  prepareCancelSubscription,
  prepareCreateSubscriptionPlan,
  prepareResumeSubscription,
  prepareSubscriptionAuthorization,
  prepareSubscriptionCollection,
  recordCoinbaseRampEvent,
  recordMoneygramRampEvent,
  resumeRecurringPayment,
  simulateSandboxTransfer,
  updateRecurringPayment,
  updateSubscriptionPlan,
  updateWalletPolicy,
} from "./handlers";
import { createPaymentRequestSchema } from "./handlers/payment-requests";
import {
  activateRecurringPaymentSchema,
  cancelRampTransferSchema,
  cancelRecurringPaymentSchema,
  coinbaseRampEventSchema,
  collectRecurringPaymentSchema,
  createOfframpQuoteSchema,
  createOnrampQuoteSchema,
  createRecurringPaymentSchema,
  createSubscriptionPlanSchema,
  createSubscriptionSchema,
  createTransferBatchSchema,
  createTransferSchema,
  estimateOfframpSchema,
  estimateOnrampSchema,
  estimateTransferBatchSchema,
  moneygramRampEventSchema,
  prepareSubscriptionAuthorizationSchema,
  prepareSubscriptionCollectionSchema,
  prepareSubscriptionLifecycleSchema,
  prepareSubscriptionPlanCreateSchema,
  resumeRecurringPaymentSchema,
  simulateSandboxTransferSchema,
  updateRecurringPaymentSchema,
  updateSubscriptionPlanSchema,
  updateWalletPolicySchema,
} from "./schemas";

const payments = new Hono<{ Bindings: Env }>();

payments.use("*", unifiedAuthMiddleware({ allowClerk: true, allowSession: true }));
payments.use("*", projectContextMiddleware());

payments.get(
  "/wallets/:walletId/balances",
  requirePermissions("wallets:read", "payments:read"),
  getWalletBalances
);
payments.get(
  "/wallets/:walletId/policies",
  requirePermissions("wallets:read", "payments:read"),
  getWalletPolicy
);
payments.get(
  "/wallets/:walletId/policies/revisions",
  requirePermissions("wallets:read", "payments:read"),
  listWalletControlProfileRevisions
);
payments.get(
  "/wallets/:walletId/policies/evaluations",
  requirePermissions("wallets:read", "payments:read"),
  listWalletPolicyEvaluations
);
payments.get(
  "/wallets/:walletId/policies/evaluations/:policyEvaluationId",
  requirePermissions("wallets:read", "payments:read"),
  getWalletPolicyEvaluation
);
payments.put(
  "/wallets/:walletId/policies",
  requirePermissions("wallets:write", "payments:write"),
  validateBody(updateWalletPolicySchema),
  updateWalletPolicy
);
payments.post(
  "/subscription-plans",
  requirePermissions("payments:write", "wallets:read"),
  validateBody(createSubscriptionPlanSchema),
  createSubscriptionPlan
);
payments.post(
  "/recurring-payments",
  requirePermissions("payments:write", "wallets:read", "counterparties:read"),
  validateBody(createRecurringPaymentSchema),
  createRecurringPayment
);
payments.get("/recurring-payments", requirePermissions("payments:read"), listRecurringPayments);
payments.patch(
  "/recurring-payments/:id",
  requirePermissions("payments:write", "wallets:read", "counterparties:read"),
  validateBody(updateRecurringPaymentSchema),
  updateRecurringPayment
);
payments.post(
  "/recurring-payments/:id/activate",
  requirePermissions("payments:write", "wallets:read"),
  validateBody(activateRecurringPaymentSchema),
  activateRecurringPayment
);
payments.post(
  "/recurring-payments/:id/cancel",
  requirePermissions("payments:write", "wallets:read"),
  validateBody(cancelRecurringPaymentSchema),
  cancelRecurringPayment
);
payments.post(
  "/recurring-payments/:id/collect",
  requirePermissions("payments:write", "wallets:read"),
  validateBody(collectRecurringPaymentSchema),
  collectRecurringPayment
);
payments.post(
  "/recurring-payments/:id/resume",
  requirePermissions("payments:write", "wallets:read"),
  validateBody(resumeRecurringPaymentSchema),
  resumeRecurringPayment
);
payments.get("/recurring-payments/:id", requirePermissions("payments:read"), getRecurringPayment);
payments.get("/subscription-plans", requirePermissions("payments:read"), listSubscriptionPlans);
payments.post(
  "/subscription-plans/:planId/prepare-create",
  requirePermissions("payments:write", "wallets:read"),
  validateBody(prepareSubscriptionPlanCreateSchema),
  prepareCreateSubscriptionPlan
);
payments.get(
  "/subscription-plans/:planId",
  requirePermissions("payments:read"),
  getSubscriptionPlan
);
payments.patch(
  "/subscription-plans/:planId",
  requirePermissions("payments:write", "wallets:read"),
  validateBody(updateSubscriptionPlanSchema),
  updateSubscriptionPlan
);
payments.post(
  "/subscriptions",
  requirePermissions("payments:write", "counterparties:read"),
  validateBody(createSubscriptionSchema),
  createSubscription
);
payments.get("/subscriptions", requirePermissions("payments:read"), listSubscriptions);
payments.post(
  "/subscriptions/:subscriptionId/prepare-authorization",
  requirePermissions("payments:write", "counterparties:read"),
  validateBody(prepareSubscriptionAuthorizationSchema),
  prepareSubscriptionAuthorization
);
payments.post(
  "/subscriptions/:subscriptionId/prepare-cancel",
  requirePermissions("payments:write"),
  validateBody(prepareSubscriptionLifecycleSchema),
  prepareCancelSubscription
);
payments.post(
  "/subscriptions/:subscriptionId/prepare-resume",
  requirePermissions("payments:write"),
  validateBody(prepareSubscriptionLifecycleSchema),
  prepareResumeSubscription
);
payments.post(
  "/subscriptions/:subscriptionId/prepare-collection",
  requirePermissions("payments:write", "wallets:read"),
  validateBody(prepareSubscriptionCollectionSchema),
  prepareSubscriptionCollection
);
payments.get(
  "/subscriptions/:subscriptionId",
  requirePermissions("payments:read"),
  getSubscription
);
payments.get(
  "/subscriptions/:subscriptionId/collection-attempts",
  requirePermissions("payments:read"),
  listSubscriptionCollectionAttempts
);
payments.post(
  "/transfers",
  requirePermissions("payments:write", "wallets:read"),
  validateBody(createTransferSchema),
  policyGate({
    extract: extractTransferPolicyCandidate,
    findIdempotentKeyReplay: findTransferIdempotentKeyReplay,
    beforeEnforce: admitTransferRuntimeExecution,
  }),
  createTransfer
);
payments.get("/transfers", requirePermissions("payments:read"), listTransfers);
payments.post(
  "/transfer-batches/estimate",
  requirePermissions("payments:read", "wallets:read", "counterparties:read"),
  validateBody(estimateTransferBatchSchema),
  estimateTransferBatch
);
payments.post(
  "/transfer-batches",
  requirePermissions("payments:write", "wallets:read", "counterparties:read"),
  validateBody(createTransferBatchSchema),
  policyGate({
    extract: extractTransferBatchPolicyCandidate,
    findIdempotentKeyReplay: findTransferBatchIdempotentKeyReplay,
    beforeEnforce: admitTransferBatchRuntimeExecution,
  }),
  createTransferBatch
);
payments.get("/transfer-batches", requirePermissions("payments:read"), listTransferBatches);
payments.get("/transfer-batches/:batchId", requirePermissions("payments:read"), getTransferBatch);
payments.get("/requests", requirePermissions("payments:read"), listPaymentRequests);
payments.post(
  "/requests",
  requirePermissions("payments:write", "wallets:read"),
  validateBody(createPaymentRequestSchema),
  createPaymentRequest
);
payments.get("/transfers/:transferId", requirePermissions("payments:read"), getTransfer);
payments.get("/ramps/onramp/currency", requirePermissions("payments:read"), listOnrampCurrencies);
payments.get("/ramps/offramp/currency", requirePermissions("payments:read"), listOfframpCurrencies);
// Estimates fan out one live call per provider on the corridor and quotes
// create provider-side records, so both carry fail-closed metered quotas.
payments.post(
  "/ramps/onramp/estimate",
  requirePermissions("payments:read"),
  validateBody(estimateOnrampSchema),
  meteredQuota({ name: "ramp-estimate", actorMax: 30, orgMax: 120 }),
  estimateOnramp
);
payments.post(
  "/ramps/offramp/estimate",
  requirePermissions("payments:read"),
  validateBody(estimateOfframpSchema),
  meteredQuota({ name: "ramp-estimate", actorMax: 30, orgMax: 120 }),
  estimateOfframp
);
payments.post(
  "/ramps/onramp/quote",
  requirePermissions("payments:write", "wallets:read"),
  validateBody(createOnrampQuoteSchema),
  meteredQuota({ name: "ramp-quote", actorMax: 20, orgMax: 60 }),
  policyGate({ extract: extractOnrampQuotePolicyCandidate }),
  createOnrampQuote
);
payments.post(
  "/ramps/offramp/quote",
  requirePermissions("payments:write", "wallets:read"),
  validateBody(createOfframpQuoteSchema),
  meteredQuota({ name: "ramp-quote", actorMax: 20, orgMax: 60 }),
  policyGate({ extract: extractOfframpQuotePolicyCandidate }),
  createOfframpQuote
);
payments.post(
  "/ramps/moneygram/events",
  requirePermissions("payments:write"),
  validateBody(moneygramRampEventSchema),
  recordMoneygramRampEvent
);
payments.post(
  "/ramps/coinbase/events",
  requirePermissions("payments:write"),
  validateBody(coinbaseRampEventSchema),
  recordCoinbaseRampEvent
);
payments.post(
  "/ramps/transfers/cancel",
  requirePermissions("payments:write"),
  validateBody(cancelRampTransferSchema),
  cancelRampTransfer
);
payments.post(
  "/ramps/sandbox/simulate",
  requirePermissions("payments:write"),
  validateBody(simulateSandboxTransferSchema),
  simulateSandboxTransfer
);

export default payments;
