/**
 * Transaction Routes
 */

import { authMiddleware, requirePermissions } from "@/middleware/auth";
import type { Env } from "@/types/env";
import { Hono } from "hono";
import { getSigningStatus, signTransaction, submitTransaction } from "./handlers";

const transactions = new Hono<{ Bindings: Env }>();

// All routes require authentication
transactions.use("*", authMiddleware());

transactions.post("/submit", requirePermissions("transactions:write"), submitTransaction);
transactions.post("/sign", requirePermissions("transactions:write"), signTransaction);
transactions.get("/signing/:requestId", requirePermissions("transactions:read"), getSigningStatus);

export default transactions;
