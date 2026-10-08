import { Hono } from "hono";
import { isExitRequest } from "@/lib/movement-exits";
import { unifiedAuthMiddleware } from "@/middleware/auth";
import { projectContextMiddleware } from "@/middleware/project-context";
import { requireModule } from "@/middleware/require-module";
import type { Env } from "@/types/env";
import paymentRequests from "./payment-requests";
import ramps from "./ramps";
import recurringPayments from "./recurring-payments";
import subscriptionPlans from "./subscription-plans";
import subscriptions from "./subscriptions";
import transferBatches from "./transfer-batches";
import transfers from "./transfers";
import walletPolicies from "./wallet-policies";

const payments = new Hono<{ Bindings: Env }>();

payments.use("/ramps/*", requireModule("ramps"));
// Refuses policy configuration. Evaluation is skipped in enforcement.service under the
// same release channel; policyGate (idempotency, operation ledger) and approval requests
// created earlier keep running.
payments.use("/wallets/:walletId/policies/*", requireModule("policies"));
payments.use("*", unifiedAuthMiddleware());
// Recurring-payment cancel is an exit (HOO-1955): open after production is revoked.
payments.use("*", projectContextMiddleware({ allowUnentitledProduction: isExitRequest }));

payments.route("/transfers", transfers);
payments.route("/transfer-batches", transferBatches);
payments.route("/requests", paymentRequests);
payments.route("/recurring-payments", recurringPayments);
payments.route("/subscription-plans", subscriptionPlans);
payments.route("/subscriptions", subscriptions);
payments.route("/wallets", walletPolicies);
payments.route("/ramps", ramps);

export default payments;
