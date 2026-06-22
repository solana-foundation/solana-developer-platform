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
  createOfframpQuote,
  createOnrampQuote,
  createRecurringPayment,
  createSubscription,
  createSubscriptionCollectionAttempt,
  createSubscriptionPlan,
  createTransfer,
  estimateOfframp,
  estimateOnramp,
  executeOfframp,
  executeOnramp,
  getRecurringPayment,
  getSubscription,
  getSubscriptionPlan,
  getTransfer,
  getWalletBalances,
  getWalletPolicy,
  listOfframpCurrencies,
  listOnrampCurrencies,
  listRecurringPayments,
  listSubscriptionCollectionAttempts,
  listSubscriptionPlans,
  listSubscriptions,
  listTransfers,
  prepareCancelSubscription,
  prepareCreateSubscriptionPlan,
  prepareResumeSubscription,
  prepareSubscriptionAuthorization,
  prepareSubscriptionCollection,
  prepareTransfer,
  recordRampProviderEvent,
  simulateSandboxTransfer,
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
payments.post(
  "/recurring-payments/:id/activate",
  requirePermissions("payments:write", "wallets:read"),
  activateRecurringPayment
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
  "/ramps/onramp/execute",
  requirePermissions("payments:write", "wallets:read"),
  executeOnramp
);
payments.post(
  "/ramps/offramp/quote",
  requirePermissions("payments:write", "wallets:read"),
  createOfframpQuote
);
payments.post(
  "/ramps/offramp/execute",
  requirePermissions("payments:write", "wallets:read"),
  executeOfframp
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
