import { Hono } from "hono";
import { unifiedAuthMiddleware } from "@/middleware/auth";
import { meteredQuota } from "@/middleware/metered-quota";
import { projectContextMiddleware } from "@/middleware/project-context";
import { validateQuery } from "@/middleware/validate";
import type { Env } from "@/types/env";
import { listUnifiedTransactions } from "./handlers";
import { unifiedTransactionsQuerySchema } from "./schemas";

// The list fans out across every module's money table in one view; the quota
// bounds how much of that shared read cost one credential can drive.
export const UNIFIED_TRANSACTIONS_QUOTA = {
  name: "unified-transactions",
  actorMax: 60,
  orgMax: 240,
};

const transactions = new Hono<{ Bindings: Env }>();

transactions.use("*", unifiedAuthMiddleware({ allowClerk: true, allowSession: true }));
transactions.use("*", projectContextMiddleware());
transactions.get(
  "/",
  validateQuery(unifiedTransactionsQuerySchema),
  meteredQuota(UNIFIED_TRANSACTIONS_QUOTA),
  listUnifiedTransactions
);

export default transactions;
