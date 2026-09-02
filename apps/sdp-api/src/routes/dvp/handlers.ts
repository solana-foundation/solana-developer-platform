import type { Context } from "hono";
import { createDvpTradeRepository, type DvpTradeRow } from "@/db/repositories";
import { getAuth, requireProjectId } from "@/lib/auth";
import { notFound } from "@/lib/errors";
import type { ValidatedBodyContext } from "@/middleware/validate";
import { createDvpTrade } from "@/services/dvp/create";
import type { Env } from "@/types/env";
import type { createDvpTradeSchema } from "./schemas";

type AppContext = Context<{ Bindings: Env }>;

/**
 * Wire shape of a trade.
 *
 * The escrow addresses are the point of this response. They are what a
 * counterparty pays into, and a plain `TransferChecked` to one is the whole of
 * their integration. Every 64-bit value stays a string, because a JSON number
 * would round it above 2^53.
 */
function toTradeResponse(row: DvpTradeRow) {
  return {
    id: row.id,
    status: row.status,
    swapDvp: row.swapDvp,
    settlementAuthority: row.settlementAuthority,
    legs: {
      a: {
        party: row.userA,
        mint: row.mintA,
        tokenProgram: row.tokenProgramA,
        amount: row.amountA,
        /** Pay this address to fund the asset leg. */
        escrow: row.escrowA,
        settlementDestination: row.userASettlementDestination,
      },
      b: {
        party: row.userB,
        mint: row.mintB,
        tokenProgram: row.tokenProgramB,
        amount: row.amountB,
        escrow: row.escrowB,
        settlementDestination: row.userBSettlementDestination,
      },
    },
    sdpSide: row.sdpSide,
    nonce: row.nonce,
    expiryTimestamp: row.expiryTimestamp,
    earliestSettlementTimestamp: row.earliestSettlementTimestamp,
    refString: row.refString,
    createSignature: row.createSignature,
    observedAt: row.observedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export const createTrade = async (c: ValidatedBodyContext<typeof createDvpTradeSchema>) => {
  const auth = getAuth(c);
  const projectId = requireProjectId(c);
  const body = c.req.valid("json");

  const trade = await createDvpTrade(c.env, {
    organizationId: auth.organizationId,
    projectId,
    sdpWalletId: body.sdpWalletId,
    sdpSide: body.sdpSide,
    counterparty: body.counterparty,
    mintA: body.mintA,
    tokenProgramA: body.tokenProgramA,
    mintB: body.mintB,
    tokenProgramB: body.tokenProgramB,
    // Strings on the wire, bigint from here in. See schemas.ts.
    amountA: BigInt(body.amountA),
    amountB: BigInt(body.amountB),
    expiryTimestamp: BigInt(body.expiryTimestamp),
    earliestSettlementTimestamp: body.earliestSettlementTimestamp
      ? BigInt(body.earliestSettlementTimestamp)
      : null,
    refString: body.refString ?? null,
  });

  return c.json({ trade: toTradeResponse(trade) }, 201);
};

export const listTrades = async (c: AppContext) => {
  const auth = getAuth(c);
  const projectId = requireProjectId(c);
  const limit = Number(c.req.query("limit") ?? 25);

  const trades = await createDvpTradeRepository(c.env).listByProject(
    { organizationId: auth.organizationId, projectId },
    Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 100) : 25
  );

  return c.json({ trades: trades.map(toTradeResponse) });
};

export const getTrade = async (c: AppContext) => {
  const auth = getAuth(c);
  const projectId = requireProjectId(c);
  const tradeId = c.req.param("tradeId");
  if (!tradeId) {
    throw notFound("DvP trade not found");
  }

  const trade = await createDvpTradeRepository(c.env).getById(
    { organizationId: auth.organizationId, projectId },
    tradeId
  );
  if (!trade) {
    throw notFound("DvP trade not found");
  }

  return c.json({ trade: toTradeResponse(trade) });
};
