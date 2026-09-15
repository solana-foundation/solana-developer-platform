import { Hono } from "hono";
import { unifiedAuthMiddleware } from "@/middleware/auth";
import { projectContextMiddleware } from "@/middleware/project-context";
import { validateQuery } from "@/middleware/validate";
import type { Env } from "@/types/env";
import { listUnifiedTransactions } from "./handlers";
import { unifiedTransactionsQuerySchema } from "./schemas";

const transactions = new Hono<{ Bindings: Env }>();

transactions.use("*", unifiedAuthMiddleware({ allowClerk: true, allowSession: true }));
transactions.use("*", projectContextMiddleware());
transactions.get("/", validateQuery(unifiedTransactionsQuerySchema), listUnifiedTransactions);

export default transactions;
