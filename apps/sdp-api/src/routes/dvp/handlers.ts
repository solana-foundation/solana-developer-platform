import * as solanaRpc from "@sdp/rpc/solana";
import { type Address, address } from "@solana/kit";
import type { Context } from "hono";
import { getDb } from "@/db";
import { createDvpTradeRepository, type DvpTradeRow } from "@/db/repositories";
import { getAuth, requireProjectId } from "@/lib/auth";
import { badRequest, notFound } from "@/lib/errors";
import { success } from "@/lib/response";
import { IDEMPOTENCY_KEY_HEADER } from "@/middleware/idempotency-key";
import { getPolicyGateContext } from "@/middleware/policy-gate";
import type { ValidatedBodyContext } from "@/middleware/validate";
import {
  assertFreshApiKeyCustodyWalletAccess,
  getAllowedApiKeyCustodyWalletIdsForPermissions,
} from "@/services/api-key-scope.service";
import { createDvpTrade } from "@/services/dvp/create";
import { fundDvpTradeLeg } from "@/services/dvp/fund";
import { inspectDvpMint } from "@/services/dvp/inspect-mint";
import { closeDvpTrade, type DvpCloseAction } from "@/services/dvp/settle";
import type { Env } from "@/types/env";
import type { DvpCloseResolved } from "./policy";
import { type createDvpTradeSchema, listDvpTradesQuerySchema } from "./schemas";

type AppContext = Context<{ Bindings: Env }>;

/**
 * The custody wallets this caller may see trades for, or null for unrestricted.
 *
 * A trade names the custody wallet that holds SDP's leg, so a wallet-scoped API
 * key reading a trade for a wallet it is not bound to would be reading outside
 * its scope. Returns an EMPTY ARRAY, not null, for a key with no usable
 * bindings — the repository reads that as deny-all.
 */
function readableSdpWalletIds(c: AppContext): string[] | null {
  return getAllowedApiKeyCustodyWalletIdsForPermissions(getAuth(c), ["payments:read"]);
}

interface LegInput {
  party: string;
  mint: string;
  tokenProgram: string;
  amount: string;
  escrow: string;
  settlementDestination: string;
  observedAmount: string | null;
  decimals: number | null;
  symbol: string | null;
  frozen: boolean | null;
}

/**
 * One leg, including what the reconciler last saw in its escrow.
 *
 * `funding` is derived here rather than left to each client, because getting it
 * wrong is consequential in both directions and the rules are not obvious:
 * settlement needs `observed >= target` on BOTH legs, and a surplus is a
 * settlement RISK rather than a harmless overpayment — settle refunds it, and
 * on a transfer-hook mint that refund can revert the whole settlement.
 *
 * Null until the reconciler has looked. Null is not zero: "nobody has paid" and
 * "we have not checked" are different answers, and collapsing them would show a
 * brand-new trade as definitively unfunded.
 */
function legResponse(leg: LegInput) {
  const funding =
    leg.observedAmount === null
      ? null
      : {
          observedAmount: leg.observedAmount,
          funded: BigInt(leg.observedAmount) >= BigInt(leg.amount),
          /** Anyone can send tokens to an escrow, so this is not rare. */
          surplus: (() => {
            const over = BigInt(leg.observedAmount) - BigInt(leg.amount);
            return over > 0n ? over.toString() : null;
          })(),
          /** A frozen escrow bounces funding, which no balance can convey. */
          frozen: leg.frozen ?? false,
        };

  return {
    party: leg.party,
    mint: leg.mint,
    tokenProgram: leg.tokenProgram,
    amount: leg.amount,
    /**
     * The mint's decimals, or null when the trade predates them being stored.
     *
     * Every amount here is base units. Without the scale a reader has no way to
     * turn 1000000000 back into the 1,000 somebody typed, which is what every
     * surface reading a trade was showing. Null rather than a default: a wrong
     * scale misstates an amount by orders of magnitude.
     */
    decimals: leg.decimals,
    /** The mint's symbol, or null when it carries no metadata. Never invented. */
    symbol: leg.symbol,
    /** Pay this address to fund the leg. */
    escrow: leg.escrow,
    settlementDestination: leg.settlementDestination,
    funding,
  };
}

/**
 * Wire shape of a trade.
 *
 * The escrow addresses are the point of this response. They are what a
 * counterparty pays into, and a plain `TransferChecked` to one is the whole of
 * their integration. Every 64-bit value stays a string, because a JSON number
 * would round it above 2^53.
 */
/** The custody wallet a trade spends from, as much of it as a reader needs. */
interface SdpWalletRef {
  address: string;
  label: string | null;
}

/**
 * Resolves the custody wallets a set of trades funds from.
 *
 * One query for the whole page rather than one per row. Missing entries are
 * simply absent: a wallet deactivated since the trade was created is a real
 * state, and the surface says the trade's wallet is no longer available rather
 * than inventing an address for it.
 */
async function readSdpWallets(env: Env, walletIds: string[]): Promise<Map<string, SdpWalletRef>> {
  const unique = [...new Set(walletIds.filter(Boolean))];
  if (unique.length === 0) {
    return new Map();
  }
  const placeholders = unique.map(() => "?").join(", ");
  const result = await getDb(env)
    .prepare(`SELECT id, public_key, label FROM custody_wallets WHERE id IN (${placeholders})`)
    .bind(...unique)
    .all<{ id: string; public_key: string; label: string | null }>();

  return new Map(
    (result.results ?? []).map((row) => [row.id, { address: row.public_key, label: row.label }])
  );
}

function toTradeResponse(row: DvpTradeRow, sdpWallet?: SdpWalletRef) {
  return {
    id: row.id,
    status: row.status,
    swapDvp: row.swapDvp,
    settlementAuthority: row.settlementAuthority,
    legs: {
      a: legResponse({
        party: row.userA,
        mint: row.mintA,
        tokenProgram: row.tokenProgramA,
        amount: row.amountA,
        escrow: row.escrowA,
        settlementDestination: row.userASettlementDestination,
        observedAmount: row.escrowAAmount,
        decimals: row.decimalsA,
        symbol: row.symbolA,
        frozen: row.escrowAFrozen,
      }),
      b: legResponse({
        party: row.userB,
        mint: row.mintB,
        tokenProgram: row.tokenProgramB,
        amount: row.amountB,
        escrow: row.escrowB,
        settlementDestination: row.userBSettlementDestination,
        observedAmount: row.escrowBAmount,
        decimals: row.decimalsB,
        symbol: row.symbolB,
        frozen: row.escrowBFrozen,
      }),
    },
    sdpSide: row.sdpSide,
    /**
     * The wallet this organization's leg is funded from.
     *
     * Absent from this response until now, which meant the only wallet-shaped
     * address on a trade page was the settlement authority — a system account
     * with signing power over the trade, sitting where a reader looks for their
     * own wallet. It was mistaken for exactly that.
     */
    sdpWallet: sdpWallet ?? null,
    nonce: row.nonce,
    expiryTimestamp: row.expiryTimestamp,
    earliestSettlementTimestamp: row.earliestSettlementTimestamp,
    refString: row.refString,
    createSignature: row.createSignature,
    /** The transaction that closed it, so settlement is verifiable after the fact. */
    closeSignature: row.closeSignature,
    /** What moved SDP's leg into escrow. */
    fundingSignature: row.sdpLegFundingSignature,
    observedAt: row.observedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export const createTrade = async (c: ValidatedBodyContext<typeof createDvpTradeSchema>) => {
  const auth = getAuth(c);
  const projectId = requireProjectId(c);
  const body = c.req.valid("json");

  // `payments:write` alone only says the key may write. It does not say which
  // wallet, and this wallet pays the fee and the escrow rent and delivers SDP's
  // leg. Re-read from the database rather than trusting the request's auth
  // context, which may be up to an hour of cached KV — the same guard Payments
  // uses before any money-moving write.
  await assertFreshApiKeyCustodyWalletAccess(getDb(c.env), auth, body.sdpWalletId, [
    "payments:write",
  ]);

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
    // Optional. Its only job is to make a retry after an ambiguous broadcast
    // return the original trade rather than create a second one.
    idempotencyKey: c.req.header(IDEMPOTENCY_KEY_HEADER) ?? null,
  });

  const wallets = await readSdpWallets(c.env, [trade.sdpWalletId]);
  return success(c, { trade: toTradeResponse(trade, wallets.get(trade.sdpWalletId)) }, 201);
};

/**
 * Settles or cancels a trade.
 *
 * The policy gate has already run by the time this executes: a denied close is
 * a 403 and one needing approval is a 202, neither of which reaches here. On an
 * approved replay it runs again with the same resolved trade, which is why the
 * gate resolves it rather than the handler.
 */
const closeTrade = (action: DvpCloseAction) => async (c: AppContext) => {
  const { resolved } = getPolicyGateContext<Record<string, unknown>, DvpCloseResolved>(c);
  if (!resolved.trade) {
    throw notFound("DvP trade not found");
  }

  // Re-read the binding from the database before anything irreversible.
  //
  // The scope used by the gate came from the request's auth context, which can
  // be up to an hour of cached KV. A binding revoked inside that window would
  // still resolve the trade and still settle it — and settle moves both legs at
  // once and closes the trade permanently, so a stale read here is not a
  // read-authorization slip, it is an irreversible spend by a revoked key.
  // Same guard Payments uses before a money-moving write, and the same one
  // create already runs.
  await assertFreshApiKeyCustodyWalletAccess(getDb(c.env), getAuth(c), resolved.trade.sdpWalletId, [
    "payments:write",
  ]);

  const result = await closeDvpTrade(c, resolved.trade, action);

  // We broadcast it, so we know what it was. Left to the sweep this becomes
  // `closed_unknown` — an honest answer to "the account vanished, why?", but a
  // silly one to give about a settlement the product just performed itself.
  await createDvpTradeRepository(c.env).recordClose(
    resolved.trade.id,
    action === "settle" ? "settled" : "cancelled",
    result.signature
  );

  return success(c, {
    tradeId: resolved.trade.id,
    action,
    signature: result.signature,
    // Named because they cost rent from the settlement wallet, and because a
    // caller seeing accounts appear should know why.
    createdAccounts: result.createdAccounts,
  });
};

/**
 * Funds SDP's leg. Same gate as settle and cancel — it spends from a custody
 * wallet, and once the escrow holds the tokens only settle, cancel or reclaim
 * gets them back.
 */
export const fundTrade = async (c: AppContext) => {
  const { resolved } = getPolicyGateContext<Record<string, unknown>, DvpCloseResolved>(c);
  if (!resolved.trade) {
    throw notFound("DvP trade not found");
  }

  await assertFreshApiKeyCustodyWalletAccess(getDb(c.env), getAuth(c), resolved.trade.sdpWalletId, [
    "payments:write",
  ]);

  const result = await fundDvpTradeLeg(c, resolved.trade);

  return success(c, {
    tradeId: resolved.trade.id,
    leg: result.leg,
    amount: result.amount,
    signature: result.signature,
  });
};

export const settleTrade = closeTrade("settle");
export const cancelTrade = closeTrade("cancel");

export const listTrades = async (c: AppContext) => {
  const auth = getAuth(c);
  const projectId = requireProjectId(c);

  const query = listDvpTradesQuerySchema.safeParse({ limit: c.req.query("limit") });
  if (!query.success) {
    throw badRequest("Invalid limit: expected an integer between 1 and 100");
  }

  const trades = await createDvpTradeRepository(c.env).listByProject(
    {
      organizationId: auth.organizationId,
      projectId,
      sdpWalletIds: readableSdpWalletIds(c),
    },
    query.data.limit
  );

  const wallets = await readSdpWallets(
    c.env,
    trades.map((trade) => trade.sdpWalletId)
  );
  return success(c, {
    trades: trades.map((trade) => toTradeResponse(trade, wallets.get(trade.sdpWalletId))),
  });
};

export const getTrade = async (c: AppContext) => {
  const auth = getAuth(c);
  const projectId = requireProjectId(c);
  const tradeId = c.req.param("tradeId");
  if (!tradeId) {
    throw notFound("DvP trade not found");
  }

  // A trade outside the key's wallet scope is 404, not 403. The scope filter is
  // part of the lookup, so an unauthorized id is indistinguishable from an
  // unknown one and nothing leaks about which trades exist.
  const trade = await createDvpTradeRepository(c.env).getById(
    {
      organizationId: auth.organizationId,
      projectId,
      sdpWalletIds: readableSdpWalletIds(c),
    },
    tradeId
  );
  if (!trade) {
    throw notFound("DvP trade not found");
  }

  const wallets = await readSdpWallets(c.env, [trade.sdpWalletId]);
  return success(c, { trade: toTradeResponse(trade, wallets.get(trade.sdpWalletId)) });
};

/**
 * Inspects a mint so the create form can take a human amount for it.
 *
 * Read-only and permissionless beyond `payments:read`: it reports public chain
 * state about an address the caller already has. The value is that it answers
 * BEFORE a trade is signed — decimals, so the amount field can convert rather
 * than demand base units, and eligibility, so a mint DvP refuses is named in
 * the form instead of surfacing as a failed create that already cost a
 * signature.
 */
export const inspectMint = async (c: AppContext) => {
  const mint = c.req.param("mint");
  if (!mint) {
    throw notFound("Mint not found");
  }

  // Validated here rather than by a schema: the param is an address, and an
  // unparseable one is the same answer as an address with nothing at it.
  let parsed: Address;
  try {
    parsed = address(mint);
  } catch {
    throw notFound("Mint not found");
  }

  const inspection = await inspectDvpMint(solanaRpc.createRpc(c.env), parsed);
  if (!inspection) {
    throw notFound("Mint not found");
  }

  return success(c, { mint: inspection });
};
