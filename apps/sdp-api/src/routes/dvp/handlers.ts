import * as solanaRpc from "@sdp/rpc/solana";
import { type Address, address } from "@solana/kit";
import type { Context } from "hono";
import { getDb } from "@/db";
import {
  createCounterpartyAccountsRepository,
  createDvpTradeRepository,
  type DvpTradeRow,
  type DvpTradeSide,
} from "@/db/repositories";
import {
  createPostgresDvpLegFundingClaimRepository,
  type DvpLegFundingClaim,
} from "@/db/repositories/dvp-leg-funding-claim.repository";
import { getAuth, requireProjectId } from "@/lib/auth";
import { badRequest, forbidden, notFound } from "@/lib/errors";
import { success } from "@/lib/response";
import { createTenantScope } from "@/lib/tenant-scope";
import { IDEMPOTENCY_KEY_HEADER } from "@/middleware/idempotency-key";
import { getPolicyGateContext } from "@/middleware/policy-gate";
import type { ValidatedBodyContext } from "@/middleware/validate";
import {
  assertFreshApiKeyCustodyWalletAccess,
  getAllowedApiKeyCustodyWalletIdsForPermissions,
} from "@/services/api-key-scope.service";
import { createDvpTrade } from "@/services/dvp/create";
import { custodyWalletForParty } from "@/services/dvp/custody-party";
import { fundDvpTradeLeg } from "@/services/dvp/fund";
import { callerPartyAddresses, listInboundDvpTrades } from "@/services/dvp/inbound";
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
import { type DvpCloseResolved, type DvpFundResolved, walletIdIfHoldsAddress } from "./policy";
import {
  type createDvpTradeSchema,
  type fundDvpTradeSchema,
  listDvpTradesQuerySchema,
} from "./schemas";

type AppContext = Context<{ Bindings: Env }>;

/**
 * The custody wallets this caller may see trades for, or null for unrestricted.
 *
 * A wallet-scoped API key may read a trade only when it is bound to a wallet
 * that is a PARTY to it (its public key equals `user_a` or `user_b`) — the
 * repository expresses that as an address join. Returns an EMPTY ARRAY, not
 * null, for a key with no usable bindings — the repository reads that as
 * deny-all.
 */
function readableSdpWalletIds(c: AppContext): string[] | null {
  return getAllowedApiKeyCustodyWalletIdsForPermissions(getAuth(c), ["payments:read"]);
}

interface LegInput {
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

/** One party of a trade, as the caller may see it. */
interface PartyRef {
  address: string;
  /**
   * The creator's registered counterparty this party is, or null for an
   * external address.
   *
   * Attribution is a fact about the CREATOR's org and only its own callers may
   * see it; the labels map is never populated for a cross-org read, so a party
   * view answers null by construction rather than by a second check. A
   * referenced account that no longer resolves (archived since create, which
   * the FK's RESTRICT allows) also reads as null: inventing a label for a dead
   * record would misstate who the party is.
   */
  counterparty: { id: string; label: string } | null;
  /** Whether the CALLER holds an active custody wallet for this address. */
  custodied: boolean;
}

/**
 * How the caller stands on a trade — display copy only, never stored and
 * never a term of the trade.
 */
export type DvpTradeKind = "agent" | "principal" | "bilateral";

/**
 * Derives the caller's standing on a trade from how many of its sides the
 * caller holds a custody wallet for.
 *
 * Display copy only: 0 sides is an agent trade (the terms were set for two
 * other parties), 1 side is a principal trade, 2 sides is bilateral. The same
 * custody map that decides what the caller can see and fund decides this, so
 * the word always matches the caller's own address set — including a
 * wallet-scoped key, whose map is its bindings.
 *
 * @param callerAddresses - The caller's custody wallet addresses (address → wallet id).
 * @param userA - Side A's party address.
 * @param userB - Side B's party address.
 * @returns The derived kind for this caller.
 */
export function deriveDvpTradeKind(
  callerAddresses: ReadonlyMap<string, string>,
  userA: string,
  userB: string
): DvpTradeKind {
  const holdsA = callerAddresses.has(userA);
  const holdsB = callerAddresses.has(userB);
  if (holdsA && holdsB) {
    return "bilateral";
  }
  if (holdsA || holdsB) {
    return "principal";
  }
  return "agent";
}

/**
 * Derives one leg's party object for the caller.
 *
 * `custodied` comes from the single discovery map, never from a per-row
 * lookup: `callerPartyAddresses` is the same rule discovery and funding
 * authorize against, key-scope aware, and building it once per request is the
 * point. `custodyWalletForParty` is the act-time single-address variant and
 * would re-derive per row — it does not belong in a read.
 */
function resolveParty(
  address: string,
  counterpartyAccountId: string | null,
  callerAddresses: ReadonlyMap<string, string>,
  counterpartyLabels: ReadonlyMap<string, string>
): PartyRef {
  if (counterpartyAccountId === null) {
    return {
      address,
      counterparty: null,
      custodied: callerAddresses.has(address),
    };
  }
  const label = counterpartyLabels.get(counterpartyAccountId);
  return {
    address,
    counterparty: label === undefined ? null : { id: counterpartyAccountId, label },
    custodied: callerAddresses.has(address),
  };
}

/**
 * The transaction that moved a leg into escrow, from its funding claim.
 *
 * The receipt first, falling back to a live claim so a funding still in
 * flight links to the transaction it is waiting on; reading the claim ALONE
 * meant the link showed for the minute the claim lived and then disappeared
 * from a leg that had funded successfully. Null when there is no claim — and
 * claims rows are tenant-scoped to the FUNDING organization, so a reader who
 * cannot see the row simply gets null; nothing is widened to change that.
 *
 * @param claims - The trade's funding claims, keyed by side.
 * @param side - The leg being answered for.
 * @returns The receipt signature, else the live claim signature, else null.
 */
function fundingSignatureFor(
  claims: ReadonlyMap<DvpTradeSide, DvpLegFundingClaim>,
  side: DvpTradeSide
): string | null {
  const claim = claims.get(side);
  if (claim === undefined) {
    return null;
  }
  if (claim.fundingTx !== null) {
    return claim.fundingTx;
  }
  return claim.signature;
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
function legResponse(leg: LegInput, party: PartyRef, fundingSignature: string | null) {
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
    party,
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
    /**
     * The transaction that moved this leg into escrow: the receipt, else the
     * live claim's signature while a funding is still in flight, else null.
     * See {@link fundingSignatureFor}.
     */
    fundingSignature,
  };
}

/**
 * Everything a read of a trade derives for the caller, resolved ONCE per
 * request rather than per row.
 */
interface TradeReadContext {
  /** The caller's custody wallet addresses (address → wallet id). */
  callerAddresses: ReadonlyMap<string, string>;
  /**
   * The creator org's counterparty display names, keyed by
   * `counterparty_accounts.id`. Only ever populated for creator-org reads;
   * a cross-org party read passes an empty map and answers null accordingly.
   */
  counterpartyLabels: ReadonlyMap<string, string>;
  /** This trade's funding claims, keyed by side. RLS-scoped to the funding org. */
  fundingClaims: ReadonlyMap<DvpTradeSide, DvpLegFundingClaim>;
}

/**
 * Wire shape of a trade.
 *
 * The escrow addresses are the point of this response. They are what a
 * counterparty pays into, and a plain `TransferChecked` to one is the whole of
 * their integration. Every 64-bit value stays a string, because a JSON number
 * would round it above 2^53.
 *
 * Everything about the CALLER's standing is derived from {@link TradeReadContext}
 * and never stored: each leg's `party` object answers whether the caller holds
 * a custody wallet for it, and `kind` is display copy from the same map.
 */
function toTradeResponse(row: DvpTradeRow, context: TradeReadContext) {
  return {
    id: row.id,
    status: row.status,
    swapDvp: row.swapDvp,
    settlementAuthority: row.settlementAuthority,
    legs: {
      a: legResponse(
        {
          mint: row.mintA,
          tokenProgram: row.tokenProgramA,
          amount: row.amountA,
          escrow: row.escrowA,
          settlementDestination: row.userASettlementDestination,
          observedAmount: row.escrowAAmount,
          decimals: row.decimalsA,
          symbol: row.symbolA,
          frozen: row.escrowAFrozen,
        },
        resolveParty(
          row.userA,
          row.counterpartyAccountIdA,
          context.callerAddresses,
          context.counterpartyLabels
        ),
        fundingSignatureFor(context.fundingClaims, "a")
      ),
      b: legResponse(
        {
          mint: row.mintB,
          tokenProgram: row.tokenProgramB,
          amount: row.amountB,
          escrow: row.escrowB,
          settlementDestination: row.userBSettlementDestination,
          observedAmount: row.escrowBAmount,
          decimals: row.decimalsB,
          symbol: row.symbolB,
          frozen: row.escrowBFrozen,
        },
        resolveParty(
          row.userB,
          row.counterpartyAccountIdB,
          context.callerAddresses,
          context.counterpartyLabels
        ),
        fundingSignatureFor(context.fundingClaims, "b")
      ),
    },
    /**
     * The caller's standing on this trade, derived per caller and never
     * stored. Display copy only: how many sides the caller holds a custody
     * wallet for (0 = agent, 1 = principal, 2 = bilateral). See
     * {@link deriveDvpTradeKind}.
     */
    kind: deriveDvpTradeKind(context.callerAddresses, row.userA, row.userB),
    nonce: row.nonce,
    expiryTimestamp: row.expiryTimestamp,
    earliestSettlementTimestamp: row.earliestSettlementTimestamp,
    refString: row.refString,
    createSignature: row.createSignature,
    /** The transaction that closed it, so settlement is verifiable after the fact. */
    closeSignature: row.closeSignature,
    observedAt: row.observedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Display names for the counterparties a set of trades attributes to.
 *
 * One batched query for the whole page, never one per row. Attribution is
 * org-scoped: only the CREATOR org's callers may see it, and every row in a
 * project-scoped read is the caller's own org's row — so this runs only for
 * creator-org reads, and the party view never fetches labels and answers null
 * by construction. An archived account simply does not resolve here, which is
 * the honest reading of a reference that no longer names a live counterparty.
 */
async function readCounterpartyLabels(
  env: Env,
  organizationId: string,
  projectId: string,
  trades: DvpTradeRow[]
): Promise<Map<string, string>> {
  const accountIds = [
    ...new Set(
      trades
        .flatMap((trade) => [trade.counterpartyAccountIdA, trade.counterpartyAccountIdB])
        .filter((id): id is string => id !== null)
    ),
  ];
  if (accountIds.length === 0) {
    return new Map();
  }
  const { rows } = await createCounterpartyAccountsRepository(
    env,
    createTenantScope({ organizationId, projectId })
  ).listBatchRecipients({
    organizationId,
    projectId,
    accountIds,
    limit: accountIds.length,
    offset: 0,
  });
  return new Map(rows.map((row) => [row.account_id, row.counterparty_display_name]));
}

/**
 * The funding claims on one trade, keyed by side.
 *
 * One query per trade. A list page is N queries — acceptable at the documented
 * limit of 100, and deliberately not widened into a batch method: claims rows
 * are tenant-scoped to the FUNDING organization, and a reader who cannot see a
 * row gets null for it, which a widened join could not express without losing
 * that scoping.
 */
async function readFundingClaims(
  env: Env,
  tradeId: string
): Promise<Map<DvpTradeSide, DvpLegFundingClaim>> {
  const claims = await createPostgresDvpLegFundingClaimRepository(getDb(env)).listForTrade(tradeId);
  return new Map(claims.map((claim) => [claim.side, claim]));
}

export const createTrade = async (c: ValidatedBodyContext<typeof createDvpTradeSchema>) => {
  const auth = getAuth(c);
  const projectId = requireProjectId(c);
  const body = c.req.valid("json");

  // `payments:write` alone only says the key may write. It does not say which
  // wallet, and a wallet named here either spends fee+rent (the payer) or is
  // staged for funding (a party slot). Re-read the binding from the database
  // rather than trusting the request's auth context, which may be up to an
  // hour of cached KV — the same guard Payments uses before any money-moving
  // write.
  //
  // An explicit `payerWalletId` spends fee+rent, so it is asserted. A
  // `partyA`/`partyB` slot given as `{ walletId }` stages that wallet for
  // funding, so it is asserted too — a key without rights over the wallet must
  // not be able to do that. The defaulted payer (the settlement wallet) needs
  // NO per-key assertion: it is project infrastructure every trade uses, and
  // key/wallet bindings gate caller-chosen wallets. The close path applies
  // policy to the settlement wallet separately.
  const assertedWalletIds = [
    ...(body.payerWalletId ? [body.payerWalletId] : []),
    ...("walletId" in body.partyA ? [body.partyA.walletId] : []),
    ...("walletId" in body.partyB ? [body.partyB.walletId] : []),
  ];
  for (const walletId of assertedWalletIds) {
    await assertFreshApiKeyCustodyWalletAccess(getDb(c.env), auth, walletId, ["payments:write"]);
  }

  const trade = await createDvpTrade(c.env, {
    organizationId: auth.organizationId,
    projectId,
    partyA: body.partyA,
    partyB: body.partyB,
    payerWalletId:
      body.payerWalletId === null || body.payerWalletId === undefined ? null : body.payerWalletId,
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

  // The response derives everything from the caller's viewpoint: one custody
  // map and one labels batch per request. A just-created trade has no funding
  // claims — claims only appear when somebody funds it — so none are read.
  const [callerAddresses, counterpartyLabels] = await Promise.all([
    callerPartyAddresses(c.env, { organizationId: auth.organizationId, projectId, auth }),
    readCounterpartyLabels(c.env, auth.organizationId, projectId, [trade]),
  ]);
  return success(
    c,
    {
      trade: toTradeResponse(trade, {
        callerAddresses,
        counterpartyLabels,
        fundingClaims: new Map<DvpTradeSide, DvpLegFundingClaim>(),
      }),
    },
    201
  );
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
  //
  // The wallet asserted is the SETTLEMENT wallet — for settle and cancel it is
  // the wallet that signs, and the trade row carries no wallet of its own.
  await assertFreshApiKeyCustodyWalletAccess(
    getDb(c.env),
    getAuth(c),
    resolved.settlement.custodyWalletId,
    ["payments:write"]
  );

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
 * Funds one side of a trade — whichever side the caller's custody wallet owns.
 *
 * Same gate as settle and cancel — it spends from a custody wallet, and once
 * the escrow holds the tokens only settle, cancel or reclaim gets them back.
 * Creator funding and party funding are the same operation now: the right to
 * fund side X is holding an active custody wallet whose public key equals
 * `user_x`.
 */
export const fundTrade = async (c: ValidatedBodyContext<typeof fundDvpTradeSchema>) => {
  const auth = getAuth(c);
  const projectId = requireProjectId(c);
  const body = c.req.valid("json");
  const { resolved } = getPolicyGateContext<Record<string, unknown>, DvpFundResolved>(c);
  if (!resolved.trade) {
    throw notFound("DvP trade not found");
  }
  const trade = resolved.trade;

  if (!resolved.funding) {
    // Not "not found": the caller can see this trade, so pretending it does not
    // exist would be a worse answer than the true one. It names two addresses
    // and they hold the key to neither.
    throw forbidden(
      `DvP trade ${trade.id}: no active custody wallet in this project holds the side ${body.side} party address`
    );
  }
  const { side } = resolved.funding;
  const partyAddress = side === "a" ? trade.userA : trade.userB;

  // PRE-BROADCAST RE-READ — the ticket's authorization invariant. The gate's
  // custody resolution and its auth context can both be stale: the auth
  // snapshot is up to an hour of cached KV, and a wallet archived since the
  // extractor resolved it would still sign. Re-derive from the database and
  // re-assert the key's binding on the wallet that comes back — the same
  // both-ends guard close runs. Omitted `walletId`, the re-read is the custody
  // lookup on the side's party address; explicit, it is that the named wallet
  // is still active in scope and still holds that address (naming narrows; a
  // wallet that stopped holding it must not pay).
  const rereadWalletId =
    body.walletId !== null && body.walletId !== undefined
      ? await walletIdIfHoldsAddress(c, body.walletId, partyAddress)
      : await custodyWalletForParty(
          c.env,
          { organizationId: auth.organizationId, projectId },
          partyAddress
        );
  if (rereadWalletId === null) {
    throw forbidden(
      `DvP trade ${trade.id}: no active custody wallet in this project holds the side ${side} party address`
    );
  }
  await assertFreshApiKeyCustodyWalletAccess(getDb(c.env), auth, rereadWalletId, [
    "payments:write",
  ]);

  const result = await fundDvpTradeLeg(c, trade, {
    side,
    custodyWalletId: rereadWalletId,
    organizationId: auth.organizationId,
    projectId,
  });

  // The tokens have moved. Waiting for the once-a-minute sweep to say so left
  // the page reading "Waiting on funds" straight after a successful transfer,
  // which is indistinguishable from it having failed.
  await observeDvpTradeNow(c.env, trade, result.signature);

  return success(c, {
    tradeId: trade.id,
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
export const listInboundTrades = async (c: AppContext) => {
  const auth = getAuth(c);
  const projectId = requireProjectId(c);

  const inbound = await listInboundDvpTrades(c.env, {
    organizationId: auth.organizationId,
    projectId,
    auth,
  });

  return success(c, {
    trades: inbound.trades.map((trade) => toDvpInboundResponse(trade, inbound.callerAddresses)),
  });
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

  // Everything a page needs is resolved once: the caller's custody map, the
  // page's counterparty labels, and each trade's claims (one query per trade —
  // N for the page, acceptable at the documented limit of 100; see
  // readFundingClaims). Claims stay index-aligned with the trades.
  const [callerAddresses, counterpartyLabels, fundingClaimsByTrade] = await Promise.all([
    callerPartyAddresses(c.env, { organizationId: auth.organizationId, projectId, auth }),
    readCounterpartyLabels(c.env, auth.organizationId, projectId, trades),
    Promise.all(trades.map((trade) => readFundingClaims(c.env, trade.id))),
  ]);
  return success(c, {
    trades: trades.map((trade, index) =>
      toTradeResponse(trade, {
        callerAddresses,
        counterpartyLabels,
        fundingClaims: fundingClaimsByTrade[index],
      })
    ),
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

  const [callerAddresses, counterpartyLabels, fundingClaims, settlementReadiness] =
    await Promise.all([
      callerPartyAddresses(c.env, { organizationId: auth.organizationId, projectId, auth }),
      readCounterpartyLabels(c.env, auth.organizationId, projectId, [observed]),
      readFundingClaims(c.env, observed.id),
      readSettlementReadiness(c, observed),
    ]);
  return success(c, {
    trade: {
      ...toTradeResponse(observed, { callerAddresses, counterpartyLabels, fundingClaims }),
      settlementReadiness,
    },
  });
};

/**
 * Which side of another organization's trade this caller is party to, if any.
 *
 * The custody lookup decides: a side is the caller's iff an active custody
 * wallet of theirs holds its party address. Key-scope filtering is applied by
 * the caller, on the result, because this answers for the ORGANIZATION — the
 * wider question — and a wallet-scoped key must not be handed a leg held by a
 * wallet it is not bound to.
 *
 * @param c - Request context.
 * @param trade - The trade, already resolved as a party read.
 * @param projectId - The caller's project id.
 * @returns The caller's side and the wallet that makes it theirs, or null when
 *   neither party address is the caller's.
 */
async function resolveYourSide(
  c: AppContext,
  trade: DvpTradeRow,
  projectId: string
): Promise<{ side: "a" | "b"; custodyWalletId: string } | null> {
  const org = { organizationId: getAuth(c).organizationId, projectId };
  const walletForA = await custodyWalletForParty(c.env, org, trade.userA);
  if (walletForA !== null) {
    return { side: "a", custodyWalletId: walletForA };
  }
  const walletForB = await custodyWalletForParty(c.env, org, trade.userB);
  if (walletForB !== null) {
    return { side: "b", custodyWalletId: walletForB };
  }
  return null;
}

/**
 * The same page, for a party who is not the trade's author.
 *
 * Answers in the SHAPE the detail page already reads, with everything belonging
 * to the creating organization withheld — rather than a second response the UI
 * would need a second branch for. What is withheld is what
 * `routes/dvp/inbound-response.ts` withholds and for the same reason: the terms
 * are on chain and theirs to read, the counterparty attribution, the funding
 * claims and the settlement readiness are ours.
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

  const fundable = await resolveYourSide(c, trade, projectId);
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

  // Derived from the caller's OWN wallets, like any other view. Attribution
  // is a fact about the creating organization, so the labels map is never
  // resolved here and answers null by construction. Funding claims ARE read,
  // and the database does the scoping: claim rows are tenant-RLS'd to the
  // funding organization, so a party that funded a leg sees its own claim and
  // anyone else gets null — nothing is widened to change that.
  const [callerAddresses, fundingClaims] = await Promise.all([
    callerPartyAddresses(c.env, {
      organizationId: auth.organizationId,
      projectId,
      auth,
    }),
    readFundingClaims(c.env, observed.id),
  ]);

  return success(c, {
    trade: {
      ...toTradeResponse(observed, {
        callerAddresses,
        counterpartyLabels: new Map<string, string>(),
        fundingClaims,
      }),
      // Theirs, not ours. `toTradeResponse` speaks to the creating org and
      // carries these; a party gets the trade without them.
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
