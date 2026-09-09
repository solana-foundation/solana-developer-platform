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
import { fundDvpTradeLegAsParty } from "@/services/dvp/fund-as-party";
import { resolveFundableLeg } from "@/services/dvp/fund-authorization";
import { listInboundDvpTrades } from "@/services/dvp/inbound";
import { inspectDvpMint } from "@/services/dvp/inspect-mint";
import {
  observeDvpTradeIfStale,
  observeDvpTradeNow,
  observeDvpTradeWithoutRecording,
} from "@/services/dvp/observe-now";
import { closeDvpTrade, type DvpCloseAction } from "@/services/dvp/settle";
import { findSettlementFundingShortfall } from "@/services/dvp/settle-preflight";
import { readDvpSettlementWallet } from "@/services/dvp/settlement-wallet";
import type { Env } from "@/types/env";
import { toDvpInboundResponse } from "./inbound-response";
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
    /** Whether SDP delivers a leg, or only set the trade up. */
    tradeKind: row.tradeKind,
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
    /**
     * What moved SDP's leg into escrow.
     *
     * The receipt, falling back to a live claim so a funding still in flight
     * links to the transaction it is waiting on. Reading the claim ALONE — as
     * this did — meant the link showed for the minute the claim lived and then
     * disappeared from a leg that had funded successfully.
     */
    fundingSignature: row.sdpLegFundingTx ?? row.sdpLegFundingSignature,
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
    // Omitted kind is principal, so callers written before agent trades
    // existed keep working unchanged.
    ...(body.tradeKind === "agent"
      ? { tradeKind: "agent" as const, partyA: body.partyA, partyB: body.partyB }
      : {
          tradeKind: "principal" as const,
          sdpSide: body.sdpSide,
          counterparty: body.counterparty,
        }),
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
    // Null means "the party's own address", which is what the program records
    // for an omitted destination. Not defaulted here: create resolves it once,
    // and the fingerprint needs to tell an omitted destination from one the
    // caller named that happens to equal the party.
    userASettlementDestination: body.userASettlementDestination ?? null,
    userBSettlementDestination: body.userBSettlementDestination ?? null,
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

  // Same reason: settling closes both escrows and the trade account, and the
  // page should show that when it happens rather than a minute later.
  await observeDvpTradeNow(c.env, resolved.trade, result.signature);

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

  // The tokens have moved. Waiting for the once-a-minute sweep to say so left
  // the page reading "Waiting on funds" straight after a successful transfer,
  // which is indistinguishable from it having failed.
  await observeDvpTradeNow(c.env, resolved.trade, result.signature);

  return success(c, {
    tradeId: resolved.trade.id,
    leg: result.leg,
    amount: result.amount,
    signature: result.signature,
  });
};

export const settleTrade = closeTrade("settle");
export const cancelTrade = closeTrade("cancel");

/**
 * Trades somebody else created that are waiting on this caller.
 *
 * No parameters at all, deliberately. The filter is the caller's own custody
 * wallet addresses, resolved server-side: a party address is the only input
 * this would otherwise take, and accepting one would make the endpoint an
 * oracle for enumerating the trades of any address on Solana.
 *
 * Its own serializer, `toDvpInboundResponse`, rather than the one the rest of
 * this file uses. That one speaks to the organization that created the trade
 * and carries fields belonging to it.
 */
/**
 * A party funding its own leg of a trade another organization created.
 *
 * Separate from `fundTrade` because the two answer authorization differently:
 * that one asks whether the caller owns the trade, this one asks whether the
 * caller holds the key to a party address on it. Folding them together would
 * mean one endpoint with two authorization rules and a branch deciding which
 * applies, on a route that moves money.
 */
export const fundTradeAsParty = async (c: AppContext) => {
  const auth = getAuth(c);
  const projectId = requireProjectId(c);
  const { resolved } = getPolicyGateContext<Record<string, unknown>, DvpCloseResolved>(c);
  if (!resolved.trade) {
    throw notFound("DvP trade not found");
  }

  // Optional, and read tolerantly because the route has never required a body.
  // It only matters when the caller holds BOTH party addresses, which happens
  // on an agent trade set up for one organization: without it leg A always
  // wins and leg B can never be funded through the product.
  const body = (await c.req.json().catch(() => ({}))) as { side?: unknown };
  const preferredSide = body.side === "a" || body.side === "b" ? body.side : undefined;

  const result = await fundDvpTradeLegAsParty(c, resolved.trade, {
    organizationId: auth.organizationId,
    projectId,
    auth,
    preferredSide,
  });

  // Same reason as the other funding path: the sweep runs once a minute and the
  // page would otherwise read "Waiting on funds" straight after a transfer that
  // worked, which is indistinguishable from one that did not.
  await observeDvpTradeNow(c.env, resolved.trade, result.signature);

  return success(c, {
    tradeId: resolved.trade.id,
    leg: result.leg,
    amount: result.amount,
    signature: result.signature,
  });
};

export const listInboundTrades = async (c: AppContext) => {
  const auth = getAuth(c);
  const projectId = requireProjectId(c);

  const inbound = await listInboundDvpTrades(c.env, {
    organizationId: auth.organizationId,
    projectId,
    auth,
  });

  return success(c, { trades: inbound.map(toDvpInboundResponse) });
};

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

/**
 * Whether the settlement authority can pay for the close this trade will need.
 *
 * Read on the detail view rather than left for the attempt, because the failure
 * it prevents is silent until it happens: the authority is provisioned empty,
 * it pays the fee and the rent for every account settlement creates, and the
 * first settle in a project failed in simulation with an error naming neither
 * the account nor the amount.
 *
 * Never fatal. This is a readiness hint on a page that has to render either
 * way; an RPC that will not answer must not take the trade with it.
 */
async function readSettlementReadiness(
  c: AppContext,
  trade: DvpTradeRow
): Promise<{ address: string; balance: string; required: string; funded: boolean } | null> {
  try {
    const settlement = await readDvpSettlementWallet(c.env, {
      organizationId: trade.organizationId,
      projectId: trade.projectId,
    });
    if (!settlement) {
      return null;
    }
    const rpc = solanaRpc.createRpc(c.env);
    // Four accounts is settlement's worst case, which is the number worth
    // quoting: telling somebody they are ready and then asking for more mid-flow
    // is worse than asking for the ceiling once.
    const funding = await findSettlementFundingShortfall(rpc, settlement.address, 4);
    return {
      address: settlement.address,
      balance: funding.balance.toString(),
      required: funding.required.toString(),
      funded: funding.shortfall === 0n,
    };
  } catch {
    return null;
  }
}

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
  // Not ours, but possibly ours to READ: a party named on a trade another
  // organization created can see it (0089), and discovery puts a link to this
  // page in front of them. Without this fallback that link is a 404 — the
  // product tells somebody a trade is waiting on them and then denies it
  // exists.
  if (!trade) {
    return respondWithPartyTrade(c, tradeId);
  }

  // The sweep runs once a minute. That is the right cadence for a background
  // job and the wrong one for somebody watching this page wait on a deposit, so
  // a request for an open trade pays for a fresh reading when the stored one has
  // aged out. Closed trades are answered from the row: they cannot change.
  const observed = await observeDvpTradeIfStale(c.env, trade);

  const [wallets, settlementReadiness] = await Promise.all([
    readSdpWallets(c.env, [observed.sdpWalletId]),
    readSettlementReadiness(c, observed),
  ]);
  return success(c, {
    trade: {
      ...toTradeResponse(observed, wallets.get(observed.sdpWalletId)),
      settlementReadiness,
    },
  });
};

/**
 * The same page, for a party who is not the trade's author.
 *
 * Answers in the SHAPE the detail page already reads, with everything belonging
 * to the creating organization withheld — rather than a second response the UI
 * would need a second branch for. What is withheld is what
 * `routes/dvp/inbound-response.ts` withholds and for the same reason: the terms
 * are on chain and theirs to read, the wallet, the reference and the settlement
 * readiness are ours.
 *
 * A 404 when they are not a party, matching the read above: an id they have no
 * claim on must be indistinguishable from one that does not exist.
 */
async function respondWithPartyTrade(c: AppContext, tradeId: string) {
  const auth = getAuth(c);
  const projectId = requireProjectId(c);

  const trade = await createDvpTradeRepository(c.env).getByIdAsParty(tradeId);
  // The 0089 policy already refuses a trade naming nobody here, so a row coming
  // back means a wallet of theirs is on it. Resolving WHICH leg is still needed
  // and still theirs to be told.
  if (!trade) {
    throw notFound("DvP trade not found");
  }

  // This path is for a trade ANOTHER organization created. Reaching it for one
  // of our own means the scoped lookup above already refused it, and the only
  // way that happens is a wallet-scoped key asking for a wallet it is not bound
  // to. Answering here would launder the trade straight past its own scope.
  //
  // The query behind `getByIdAsParty` is deliberately unfiltered and leans on
  // RLS 0089 to decide who may see the row. That is correct in a deployed
  // environment and enforces nothing locally, where the API connects as a role
  // that bypasses RLS, so this cannot be the only thing standing between a key
  // and another wallet's trade.
  if (trade.organizationId === auth.organizationId) {
    throw notFound("DvP trade not found");
  }

  const fundable = await resolveFundableLeg(c.env, trade, {
    organizationId: auth.organizationId,
    projectId,
    auth,
  });
  if (!fundable) {
    throw notFound("DvP trade not found");
  }

  // The party leg resolves against the ORGANIZATION's addresses, which is a
  // wider question than the one the key is allowed to ask. Without this the
  // scope filter on the lookup above is decorative: it refuses the trade and
  // this fallback hands the same trade straight back to a key bound to a
  // different wallet. Same 404 as everywhere else, so the two paths cannot be
  // told apart from outside.
  const scopedWalletIds = readableSdpWalletIds(c);
  if (scopedWalletIds !== null && !scopedWalletIds.includes(fundable.custodyWalletId)) {
    throw notFound("DvP trade not found");
  }

  // Read, not recorded. Persisting it would be an UPDATE on another
  // organization's row, which 0089 refuses by design.
  const observed = await observeDvpTradeWithoutRecording(c.env, trade);

  return success(c, {
    trade: {
      ...toTradeResponse(observed, undefined),
      // Theirs, not ours. `toTradeResponse` speaks to the creating org and
      // carries these; a party gets the trade without them.
      sdpWallet: null,
      refString: null,
      settlementReadiness: null,
      /** Which leg is the reader's, so the page can say so. */
      yourSide: fundable.side,
    },
  });
}

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
