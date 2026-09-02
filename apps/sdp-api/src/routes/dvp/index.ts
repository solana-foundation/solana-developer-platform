import { type Context, Hono, type Next } from "hono";
import { AppError } from "@/lib/errors";
import { isDvpEnabled } from "@/lib/feature-flags";
import { requirePermissions, unifiedAuthMiddleware } from "@/middleware/auth";
import { projectContextMiddleware } from "@/middleware/project-context";
import { validateBody } from "@/middleware/validate";
import type { Env } from "@/types/env";
import { createTrade, getTrade, listTrades } from "./handlers";
import { createDvpTradeSchema } from "./schemas";

const dvp = new Hono<{ Bindings: Env }>();

/**
 * Router-wide gate: 403 unless both the Markets parent flag and the DvP flag are
 * on. Applied once as middleware so every current and future route inherits it.
 *
 * Worth knowing when enabling this: the DvP swap program is deployed on devnet
 * only. Turning the flag on against a mainnet cluster produces trades that
 * cannot be created at all, because the program does not exist there (PRO-1798).
 */
async function requireDvpFeature(c: Context<{ Bindings: Env }>, next: Next) {
  if (!isDvpEnabled(c.env)) {
    throw new AppError("FORBIDDEN", "DvP settlement is not enabled for this environment.");
  }
  await next();
}

dvp.use("*", requireDvpFeature);
dvp.use("*", unifiedAuthMiddleware({ allowClerk: true, allowSession: true }));
dvp.use("*", projectContextMiddleware());

// Creating a trade is permissionless on chain and costs rent, so it is a write.
// It also does NOT commit either party: only the payer signs, and the trade is a
// proposal until somebody funds an escrow.
dvp.post(
  "/trades",
  requirePermissions("payments:write"),
  validateBody(createDvpTradeSchema),
  createTrade
);
dvp.get("/trades", requirePermissions("payments:read"), listTrades);
dvp.get("/trades/:tradeId", requirePermissions("payments:read"), getTrade);

export default dvp;
