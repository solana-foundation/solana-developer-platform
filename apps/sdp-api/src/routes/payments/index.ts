import type { Next } from "hono";
import { type Context, Hono } from "hono";
import { AppError } from "@/lib/errors";
import { isRecurringPaymentsEnabled } from "@/lib/feature-flags";
import { requirePermissions, unifiedAuthMiddleware } from "@/middleware/auth";
import { projectContextMiddleware } from "@/middleware/project-context";
import type { Env } from "@/types/env";
import {
  activateRecurringPayment,
  cancelRampTransfer,
  cancelRecurringPayment,
  collectRecurringPayment,
  createOfframpQuote,
  createOnrampQuote,
  createPaymentRequest,
  createRecurringPayment,
  createSubscription,
  createSubscriptionCollectionAttempt,
  createSubscriptionPlan,
  createTransfer,
  createTransferBatch,
  estimateOfframp,
  estimateOnramp,
  estimateTransferBatch,
  getRecurringPayment,
  getSubscription,
  getSubscriptionPlan,
  getTransfer,
  getTransferBatch,
  getWalletBalances,
  getWalletPolicy,
  listOfframpCurrencies,
  listOnrampCurrencies,
  listPaymentRequests,
  listRecurringPayments,
  listSubscriptionCollectionAttempts,
  listSubscriptionPlans,
  listSubscriptions,
  listTransferBatches,
  listTransfers,
  prepareCancelSubscription,
  prepareCreateSubscriptionPlan,
  prepareResumeSubscription,
  prepareSubscriptionAuthorization,
  prepareSubscriptionCollection,
  prepareTransfer,
  recordRampProviderEvent,
  resumeRecurringPayment,
  simulateSandboxTransfer,
  updateRecurringPayment,
  updateSubscription,
  updateSubscriptionPlan,
  updateWalletPolicy,
} from "./handlers";

const payments = new Hono<{ Bindings: Env }>();

async function requireRecurringPaymentsFeature(c: Context<{ Bindings: Env }>, next: Next) {
  if (!isRecurringPaymentsEnabled(c.env)) {
    throw new AppError("FORBIDDEN", "Recurring payments are not enabled for this environment");
  }

  await next();
}

payments.use("*", unifiedAuthMiddleware({ allowClerk: true, allowSession: true }));
payments.use("*", projectContextMiddleware());
payments.use("/subscription-plans", requireRecurringPaymentsFeature);
payments.use("/subscription-plans/*", requireRecurringPaymentsFeature);
payments.use("/subscriptions", requireRecurringPaymentsFeature);
payments.use("/subscriptions/*", requireRecurringPaymentsFeature);
payments.use("/recurring-payments", requireRecurringPaymentsFeature);
payments.use("/recurring-payments/*", requireRecurringPaymentsFeature);

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
payments.put(
  "/wallets/:walletId/policies",
  requirePermissions("wallets:write", "payments:write"),
  updateWalletPolicy
);
payments.post(
  "/transfers/prepare",
  requirePermissions("payments:write", "wallets:read"),
  prepareTransfer
);
payments.post(
  "/subscription-plans",
  requirePermissions("payments:write", "wallets:read"),
  createSubscriptionPlan
);
payments.post(
  "/recurring-payments",
  requirePermissions("payments:write", "wallets:read", "counterparties:read"),
  createRecurringPayment
);
payments.get("/recurring-payments", requirePermissions("payments:read"), listRecurringPayments);
payments.patch(
  "/recurring-payments/:id",
  requirePermissions("payments:write", "wallets:read", "counterparties:read"),
  updateRecurringPayment
);
payments.post(
  "/recurring-payments/:id/activate",
  requirePermissions("payments:write", "wallets:read"),
  activateRecurringPayment
);
payments.post(
  "/recurring-payments/:id/cancel",
  requirePermissions("payments:write", "wallets:read"),
  cancelRecurringPayment
);
payments.post(
  "/recurring-payments/:id/collect",
  requirePermissions("payments:write", "wallets:read"),
  collectRecurringPayment
);
payments.post(
  "/recurring-payments/:id/resume",
  requirePermissions("payments:write", "wallets:read"),
  resumeRecurringPayment
);
payments.get("/recurring-payments/:id", requirePermissions("payments:read"), getRecurringPayment);
payments.get("/subscription-plans", requirePermissions("payments:read"), listSubscriptionPlans);
payments.post(
  "/subscription-plans/:planId/prepare-create",
  requirePermissions("payments:write", "wallets:read"),
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
  updateSubscriptionPlan
);
payments.post(
  "/subscriptions",
  requirePermissions("payments:write", "counterparties:read"),
  createSubscription
);
payments.get("/subscriptions", requirePermissions("payments:read"), listSubscriptions);
payments.post(
  "/subscriptions/:subscriptionId/prepare-authorization",
  requirePermissions("payments:write", "counterparties:read"),
  prepareSubscriptionAuthorization
);
payments.post(
  "/subscriptions/:subscriptionId/prepare-cancel",
  requirePermissions("payments:write"),
  prepareCancelSubscription
);
payments.post(
  "/subscriptions/:subscriptionId/prepare-resume",
  requirePermissions("payments:write"),
  prepareResumeSubscription
);
payments.post(
  "/subscriptions/:subscriptionId/prepare-collection",
  requirePermissions("payments:write", "wallets:read"),
  prepareSubscriptionCollection
);
payments.get(
  "/subscriptions/:subscriptionId",
  requirePermissions("payments:read"),
  getSubscription
);
payments.patch(
  "/subscriptions/:subscriptionId",
  requirePermissions("payments:write"),
  updateSubscription
);
payments.post(
  "/subscriptions/:subscriptionId/collection-attempts",
  requirePermissions("payments:write"),
  createSubscriptionCollectionAttempt
);
payments.get(
  "/subscriptions/:subscriptionId/collection-attempts",
  requirePermissions("payments:read"),
  listSubscriptionCollectionAttempts
);
payments.post("/transfers", requirePermissions("payments:write", "wallets:read"), createTransfer);
payments.get("/transfers", requirePermissions("payments:read"), listTransfers);
payments.post(
  "/transfer-batches/estimate",
  requirePermissions("payments:read", "wallets:read", "counterparties:read"),
  estimateTransferBatch
);
payments.post(
  "/transfer-batches",
  requirePermissions("payments:write", "wallets:read", "counterparties:read"),
  createTransferBatch
);
payments.get("/transfer-batches", requirePermissions("payments:read"), listTransferBatches);
payments.get("/transfer-batches/:batchId", requirePermissions("payments:read"), getTransferBatch);
payments.get("/requests", requirePermissions("payments:read"), listPaymentRequests);
payments.post(
  "/requests",
  requirePermissions("payments:write", "wallets:read"),
  createPaymentRequest
);
payments.get("/transfers/:transferId", requirePermissions("payments:read"), getTransfer);
payments.get("/ramps/onramp/currency", requirePermissions("payments:read"), listOnrampCurrencies);
payments.get("/ramps/offramp/currency", requirePermissions("payments:read"), listOfframpCurrencies);
payments.post("/ramps/onramp/estimate", requirePermissions("payments:read"), estimateOnramp);
payments.post("/ramps/offramp/estimate", requirePermissions("payments:read"), estimateOfframp);
payments.post(
  "/ramps/onramp/quote",
  requirePermissions("payments:write", "wallets:read"),
  createOnrampQuote
);
payments.post(
  "/ramps/offramp/quote",
  requirePermissions("payments:write", "wallets:read"),
  createOfframpQuote
);
payments.post(
  "/ramps/:provider/events",
  requirePermissions("payments:write"),
  recordRampProviderEvent
);
payments.post("/ramps/transfers/cancel", requirePermissions("payments:write"), cancelRampTransfer);
payments.post(
  "/ramps/sandbox/simulate",
  requirePermissions("payments:write"),
  simulateSandboxTransfer
);

export default payments;
