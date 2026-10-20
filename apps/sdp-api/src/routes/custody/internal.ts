/**
 * Dashboard-only wallet routes: refused to API keys and kept out of the OpenAPI documents.
 */

import { Hono } from "hono";
import { unifiedAuthMiddleware } from "@/middleware/auth";
import { authorize } from "@/middleware/authorize";
import { requireHumanSession } from "@/middleware/human-session";
import { meteredQuota } from "@/middleware/metered-quota";
import { projectContextMiddleware } from "@/middleware/project-context";
import { requireAction } from "@/middleware/require-action";
import { validateBody, validateParams } from "@/middleware/validate";
import { requestWalletFaucet } from "@/routes/custody/handlers/faucet";
import type { Env } from "@/types/env";
import { authorizeWalletFaucet } from "./access";
import { walletFaucetSchema, walletIdParamsSchema } from "./schemas";

export const internalWallets = new Hono<{ Bindings: Env }>();

internalWallets.use("*", unifiedAuthMiddleware());
internalWallets.use("*", requireHumanSession());
internalWallets.use("*", projectContextMiddleware());

internalWallets.post(
  "/:walletId/faucet",
  requireAction("wallets.execute"),
  validateParams(walletIdParamsSchema),
  validateBody(walletFaucetSchema),
  authorize(authorizeWalletFaucet),
  // One press can walk the devnet pool and poll its status: the org ceiling
  // keeps one tenant from draining the shared faucet providers.
  meteredQuota({ name: "wallet-faucet", actorMax: 5, orgMax: 20 }),
  requestWalletFaucet
);
