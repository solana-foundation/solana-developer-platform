import { type Context, Hono, type Next } from "hono";
import { forbidden } from "@/lib/errors";
import { isDvpEnabled } from "@/lib/feature-flags";
import { unifiedAuthMiddleware } from "@/middleware/auth";
import { meteredQuota } from "@/middleware/metered-quota";
import { projectContextMiddleware } from "@/middleware/project-context";
import { requireAction } from "@/middleware/require-action";
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
  reclaimTrade,
  settleTrade,
} from "./handlers";
import { createDvpTradeSchema, fundDvpTradeSchema } from "./schemas";

export const dvp = new Hono<{ Bindings: Env }>();

/**
 * Gates every DvP route behind the Markets module flag.
 *
 * The DvP swap program exists on devnet only (PRO-1798).
 */
async function requireDvpFeature(c: Context<{ Bindings: Env }>, next: Next) {
  if (!isDvpEnabled(c.env)) {
    throw forbidden("Markets is not enabled for this environment.");
  }
  await next();
}

dvp.use("*", requireDvpFeature);
dvp.use("*", unifiedAuthMiddleware());
dvp.use("*", projectContextMiddleware());

// Each route declares one action. Trade reads are project-scoped; a key's
// wallet scope applies when SDP signs a funding, payer or settlement
// transaction, at the custody signer (HOO-2099).

// Creating a trade is permissionless on chain and costs rent, so it is a write.
// It also does NOT commit either party: only the payer signs, and the trade is a
// proposal until somebody funds an escrow.
dvp.post(
  "/trades",
  requireAction("dvp.manage"),
  validateBody(createDvpTradeSchema),
  meteredQuota({ name: "dvp-create", actorMax: 2, orgMax: 10 }),
  createTrade
);
// Reading a mint so the form can convert an amount. Read-only, and public
// chain state about an address the caller already holds — but still behind
// `dvp.read` so it does not become an unauthenticated RPC proxy.
dvp.get("/mints/:mint", requireAction("dvp.read"), inspectMint);
dvp.get("/trades", requireAction("dvp.read"), listTrades);
// BEFORE `/trades/:tradeId`, or the parameter route swallows it and "inbound"
// is looked up as a trade id. Trades another organization created that name one
// of this caller's wallets; takes no parameters, because the only one it could
// take is a party address and that would make it an enumeration oracle.
dvp.get("/trades/inbound", requireAction("dvp.read"), listInboundTrades);
dvp.get("/trades/:tradeId", requireAction("dvp.read"), getTrade);

// Funding ONE side — creator and party funding are the same operation: the
// right to fund side X is holding a custody wallet whose public key equals
// that side's party address. Validation precedes quota so malformed bodies do
// not consume the execution quota. Needs `dvp.execute`: this is the
// action that commits a custody wallet's tokens to an escrow.
dvp.post(
  "/trades/:tradeId/fund",
  requireAction("dvp.execute"),
  validateBody(fundDvpTradeSchema),
  meteredQuota({ name: "dvp-fund", actorMax: 2, orgMax: 10 }),
  fundTrade
);
// Reclaiming ONE side: the program only lets the leg's own party sign, and the
// deposit goes back to that party. The trade stays open. It is the party's way
// back out of an escrow, so it needs only `dvp.manage`: a key that may no
// longer fund can still unwind. (Coarse: review before DvP is promoted.)
dvp.post(
  "/trades/:tradeId/reclaim",
  requireAction("dvp.manage"),
  validateBody(fundDvpTradeSchema),
  meteredQuota({ name: "dvp-reclaim", actorMax: 2, orgMax: 10 }),
  reclaimTrade
);
// Settle and cancel are the only two actions the settlement authority can take,
// and both are irreversible: settle delivers both legs and closes the trade,
// cancel refunds both and closes it. Settle needs `dvp.execute`; cancel needs
// only `dvp.manage`, because it is how an unwanted trade is unwound and a key
// that can no longer execute must not leave both deposits in escrow.
dvp.post(
  "/trades/:tradeId/settle",
  requireAction("dvp.execute"),
  meteredQuota({ name: "dvp-settle", actorMax: 2, orgMax: 10 }),
  settleTrade
);
dvp.post(
  "/trades/:tradeId/cancel",
  requireAction("dvp.manage"),
  meteredQuota({ name: "dvp-cancel", actorMax: 2, orgMax: 10 }),
  cancelTrade
);
