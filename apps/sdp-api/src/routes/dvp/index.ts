import { type Context, Hono, type Next } from "hono";
import { forbidden } from "@/lib/errors";
import { isMarketsEnabled } from "@/lib/feature-flags";
import { requirePermissions, unifiedAuthMiddleware } from "@/middleware/auth";
import { meteredQuota } from "@/middleware/metered-quota";
import { projectContextMiddleware } from "@/middleware/project-context";
import { validateBody } from "@/middleware/validate";
import type { Env } from "@/types/env";
import {
  cancelTrade,
  createTrade,
  fundTrade,
  getTrade,
  inspectMint,
  listInboundTrades,
  listTrades,
  settleTrade,
} from "./handlers";
import { createDvpTradeSchema, fundDvpTradeSchema } from "./schemas";

const dvp = new Hono<{ Bindings: Env }>();

/**
 * Gates every DvP route behind the Markets module flag.
 *
 * The DvP swap program exists on devnet only (PRO-1798).
 */
async function requireDvpFeature(c: Context<{ Bindings: Env }>, next: Next) {
  if (!isMarketsEnabled(c.env)) {
    throw forbidden("Markets is not enabled for this environment.");
  }
  await next();
}

dvp.use("*", requireDvpFeature);
dvp.use("*", unifiedAuthMiddleware({ allowClerk: true, allowSession: true }));
dvp.use("*", projectContextMiddleware());

// Every route below pairs `wallets:read` with its own scope, the way Payments
// does (`routes/payments/index.ts:131`). These routes all resolve a custody
// wallet, and the per-wallet ownership assertion is a documented no-op for a
// key with no wallet bindings — so for exactly the keys that assertion cannot
// govern, the router permission is the only gate they have to meet.

// Creating a trade is permissionless on chain and costs rent, so it is a write.
// It also does NOT commit either party: only the payer signs, and the trade is a
// proposal until somebody funds an escrow.
dvp.post(
  "/trades",
  requirePermissions("payments:write", "wallets:read"),
  validateBody(createDvpTradeSchema),
  meteredQuota({ name: "dvp-create", actorMax: 2, orgMax: 10 }),
  createTrade
);
// Reading a mint so the form can convert an amount. Read-only, and public
// chain state about an address the caller already holds — but still behind
// `payments:read` so it does not become an unauthenticated RPC proxy.
dvp.get("/mints/:mint", requirePermissions("wallets:read", "payments:read"), inspectMint);
dvp.get("/trades", requirePermissions("wallets:read", "payments:read"), listTrades);
// BEFORE `/trades/:tradeId`, or the parameter route swallows it and "inbound"
// is looked up as a trade id. Trades another organization created that name one
// of this caller's wallets; takes no parameters, because the only one it could
// take is a party address and that would make it an enumeration oracle.
dvp.get("/trades/inbound", requirePermissions("wallets:read", "payments:read"), listInboundTrades);
dvp.get("/trades/:tradeId", requirePermissions("wallets:read", "payments:read"), getTrade);

// Funding ONE side — creator and party funding are the same operation: the
// right to fund side X is holding a custody wallet whose public key equals
// that side's party address. Validation precedes quota so malformed bodies do
// not consume the execution quota.
dvp.post(
  "/trades/:tradeId/fund",
  requirePermissions("payments:write", "wallets:read"),
  validateBody(fundDvpTradeSchema),
  meteredQuota({ name: "dvp-fund", actorMax: 2, orgMax: 10 }),
  fundTrade
);
// Settle and cancel are the only two actions the settlement authority can take,
// and both are irreversible: settle delivers both legs and closes the trade,
// cancel refunds both and closes it. DvP actions currently resolve their inputs
// and execute directly without wallet-policy evaluation.
dvp.post(
  "/trades/:tradeId/settle",
  requirePermissions("payments:write", "wallets:read"),
  meteredQuota({ name: "dvp-settle", actorMax: 2, orgMax: 10 }),
  settleTrade
);
dvp.post(
  "/trades/:tradeId/cancel",
  requirePermissions("payments:write", "wallets:read"),
  meteredQuota({ name: "dvp-cancel", actorMax: 2, orgMax: 10 }),
  cancelTrade
);

export default dvp;
