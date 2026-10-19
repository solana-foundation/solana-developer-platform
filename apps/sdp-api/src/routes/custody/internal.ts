/**
 * Dashboard-only wallet routes: refused to API keys and kept out of the OpenAPI documents.
 */

import { Hono } from "hono";
import { requireClerkSession, requirePermissions, unifiedAuthMiddleware } from "@/middleware/auth";
import { authorize } from "@/middleware/authorize";
import { projectContextMiddleware } from "@/middleware/project-context";
import { validateBody, validateParams } from "@/middleware/validate";
import { requestWalletFaucet } from "@/routes/custody/handlers/faucet";
import type { Env } from "@/types/env";
import { authorizeWalletFaucet } from "./access";
import { walletFaucetSchema, walletIdParamsSchema } from "./schemas";

export const internalWallets = new Hono<{ Bindings: Env }>();

internalWallets.use("*", unifiedAuthMiddleware());
internalWallets.use("*", requireClerkSession());
internalWallets.use("*", projectContextMiddleware());

internalWallets.post(
  "/:walletId/faucet",
  requirePermissions("wallets:write"),
  validateParams(walletIdParamsSchema),
  validateBody(walletFaucetSchema),
  authorize(authorizeWalletFaucet),
  requestWalletFaucet
);
