import { Hono } from "hono";
import { requirePermissions, unifiedAuthMiddleware } from "@/middleware/auth";
import { meteredQuota } from "@/middleware/metered-quota";
import { policyGate } from "@/middleware/policy-gate";
import { projectContextMiddleware } from "@/middleware/project-context";
import { validateBody } from "@/middleware/validate";
import type { Env } from "@/types/env";
import {
  cancelRampTransfer,
  createOfframpQuote,
  createOnrampQuote,
  estimateOfframp,
  estimateOnramp,
  extractOfframpQuotePolicyCandidate,
  extractOnrampQuotePolicyCandidate,
  listOfframpCurrencies,
  listOnrampCurrencies,
  recordCoinbaseRampEvent,
  recordMoneygramRampEvent,
  simulateSandboxTransfer,
} from "./handlers";
import paymentRequests from "./payment-requests";
import recurringPayments from "./recurring-payments";
import {
  cancelRampTransferSchema,
  coinbaseRampEventSchema,
  createOfframpQuoteSchema,
  createOnrampQuoteSchema,
  estimateOfframpSchema,
  estimateOnrampSchema,
  moneygramRampEventSchema,
  simulateSandboxTransferSchema,
} from "./schemas";
import subscriptionPlans from "./subscription-plans";
import subscriptions from "./subscriptions";
import transferBatches from "./transfer-batches";
import transfers from "./transfers";
import walletPolicies from "./wallet-policies";

const payments = new Hono<{ Bindings: Env }>();

payments.use("*", unifiedAuthMiddleware({ allowClerk: true, allowSession: true }));
payments.use("*", projectContextMiddleware());

payments.route("/transfers", transfers);
payments.route("/transfer-batches", transferBatches);
payments.route("/requests", paymentRequests);
payments.route("/recurring-payments", recurringPayments);
payments.route("/subscription-plans", subscriptionPlans);
payments.route("/subscriptions", subscriptions);
payments.route("/wallets", walletPolicies);
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
