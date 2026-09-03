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
  listTrades,
  settleTrade,
} from "./handlers";
import { extractDvpTradeActionPolicyCandidate } from "./policy";
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
// Reading a mint so the form can convert an amount. Read-only, and public
// chain state about an address the caller already holds — but still behind
// `payments:read` so it does not become an unauthenticated RPC proxy.
dvp.get("/mints/:mint", requirePermissions("payments:read"), inspectMint);
dvp.get("/trades", requirePermissions("payments:read"), listTrades);
dvp.get("/trades/:tradeId", requirePermissions("payments:read"), getTrade);

// Settle and cancel are the only two actions the settlement authority can take,
// and both are irreversible: settle delivers both legs and closes the trade,
// cancel refunds both and closes it. They go through the policy gate like any
// other custody spend, so an organization can require approval on a transaction
// that moves both sides of a trade at once. They are separate operation types
// because allowing an unwind is not the same as allowing a settlement.
// Funding SDP's own leg. The counterparty needs nothing from us to fund theirs
// — an ordinary TransferChecked to the escrow is the whole of their
// integration — but SDP holds the other leg, and without this the only way to
// move it was a hand-written Payments transfer to the escrow address.
dvp.post(
  "/trades/:tradeId/fund",
  requirePermissions("payments:write"),
  policyGate({ extract: (c) => extractDvpTradeActionPolicyCandidate(c, "fund") }),
  fundTrade
);
dvp.post(
  "/trades/:tradeId/settle",
  requirePermissions("payments:write"),
  policyGate({ extract: (c) => extractDvpTradeActionPolicyCandidate(c, "settle") }),
  settleTrade
);
dvp.post(
  "/trades/:tradeId/cancel",
  requirePermissions("payments:write"),
  policyGate({ extract: (c) => extractDvpTradeActionPolicyCandidate(c, "cancel") }),
  cancelTrade
);

export default dvp;
