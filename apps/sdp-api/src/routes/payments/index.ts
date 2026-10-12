import { Hono } from "hono";
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
import walletBalances from "./wallet-balances";

const payments = new Hono<{ Bindings: Env }>();

payments.use("/ramps/*", requireModule("ramps"));
payments.use("*", unifiedAuthMiddleware());
payments.use("*", projectContextMiddleware());

payments.route("/transfers", transfers);
payments.route("/transfer-batches", transferBatches);
payments.route("/requests", paymentRequests);
payments.route("/recurring-payments", recurringPayments);
payments.route("/subscription-plans", subscriptionPlans);
payments.route("/subscriptions", subscriptions);
payments.route("/wallets", walletBalances);
payments.route("/ramps", ramps);

export default payments;
