import { type Context, Hono, type Next } from "hono";
import { AppError } from "@/lib/errors";
import { isDvpEnabled } from "@/lib/feature-flags";
import { requirePermissions, unifiedAuthMiddleware } from "@/middleware/auth";
import { policyGate } from "@/middleware/policy-gate";
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
import { extractDvpFundPolicyCandidate, extractDvpTradeActionPolicyCandidate } from "./policy";
import { createDvpTradeSchema, fundDvpTradeSchema } from "./schemas";

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

// Funding ONE side of a trade — whichever side the caller names. Creator
// funding and party funding are the same operation: the right to fund side X
// is holding an active custody wallet whose public key equals that side's
// party address. Bilateral trades take two calls, one claim each.
//
// The gate sits AFTER `validateBody`, exactly like every other body-validated
// policy-gated route (earn vault deposits), so a malformed body is a 400 from
// the schema rather than an extraction failure, and a denial is decided before
// any custody or RPC access.
dvp.post(
  "/trades/:tradeId/fund",
  requirePermissions("payments:write", "wallets:read"),
  validateBody(fundDvpTradeSchema),
  policyGate({ extract: (c) => extractDvpFundPolicyCandidate(c) }),
  fundTrade
);
// Settle and cancel are the only two actions the settlement authority can take,
// and both are irreversible: settle delivers both legs and closes the trade,
// cancel refunds both and closes it. They go through the policy gate like any
// other custody spend, so an organization can require approval on a transaction
// that moves both sides of a trade at once. They are separate operation types
// because allowing an unwind is not the same as allowing a settlement.
dvp.post(
  "/trades/:tradeId/settle",
  requirePermissions("payments:write", "wallets:read"),
  policyGate({ extract: (c) => extractDvpTradeActionPolicyCandidate(c, "settle") }),
  settleTrade
);
dvp.post(
  "/trades/:tradeId/cancel",
  requirePermissions("payments:write", "wallets:read"),
  policyGate({ extract: (c) => extractDvpTradeActionPolicyCandidate(c, "cancel") }),
  cancelTrade
);

export default dvp;
