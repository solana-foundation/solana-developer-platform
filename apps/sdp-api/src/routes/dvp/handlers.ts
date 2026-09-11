import * as solanaRpc from "@sdp/rpc/solana";
import { DVP_TRADE_STATUSES } from "@sdp/types";
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
  assertFreshApiKeyActive,
  assertFreshApiKeyCustodyWalletAccess,
  getAllowedApiKeyCustodyWalletIdsForPermissions,
} from "@/services/api-key-scope.service";
import { createDvpTrade } from "@/services/dvp/create";
import { custodyWalletForParty } from "@/services/dvp/custody-party";
import { fundDvpTradeLeg } from "@/services/dvp/fund";
import type { DvpCallerWallet } from "@/services/dvp/inbound";
import { callerPartyAddresses, listInboundDvpTrades } from "@/services/dvp/inbound";
import { inspectDvpMint } from "@/services/dvp/inspect-mint";
import { deriveDvpLegOutcome } from "@/services/dvp/leg-outcome";
import {
  observeDvpTradeIfStale,
  observeDvpTradeNow,
  observeDvpTradeWithoutRecording,
} from "@/services/dvp/observe-now";
import { closeDvpTrade, type DvpCloseAction } from "@/services/dvp/settle";
import { TokenService } from "@/services/token.service";
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
 * Empty means deny-all, never "no filter".
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
  name: string | null;
  imageUrl: string | null;
  frozen: boolean | null;
  outcome: ReturnType<typeof deriveDvpLegOutcome>;
}

/** One party of a trade, as the caller may see it. */
interface PartyRef {
  address: string;
  /** The creator org's registered counterparty, or null (attribution never crosses orgs; a dead reference reads null). */
  counterparty: { id: string; label: string } | null;
  /** The caller's custody wallet holding this address, or null. Truthy = the caller custodies this party. */
  wallet: DvpCallerWallet | null;
}

/**
 * How the caller stands on a trade — display copy only, never stored and
 * never a term of the trade.
 */
export type DvpTradeKind = "agent" | "principal" | "bilateral";

/**
 * The caller's standing on a trade: agent (0 sides held), principal (1),
 * bilateral (2). Display copy only, derived from the same custody map that
 * decides what the caller can see and fund.
 *
 * @param callerAddresses - The caller's custody wallets (address → wallet identity).
 * @param userA - Side A's party address.
 * @param userB - Side B's party address.
 * @returns The standing kind.
 */
export function deriveDvpTradeKind(
  callerAddresses: ReadonlyMap<string, DvpCallerWallet>,
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
 * One leg's party object: `wallet` from the request's single custody map,
 * never a per-row lookup.
 *
 * @param address - The party address on the wire.
 * @param counterpartyAccountId - The creator's counterparty link stored on the row, or null.
 * @param callerAddresses - The caller's custody wallets (address → wallet identity).
 * @param counterpartyLabels - Creator-org counterparty display names, keyed by account id.
 * @returns The party object the response carries.
 */
function resolveParty(
  address: string,
  counterpartyAccountId: string | null,
  callerAddresses: ReadonlyMap<string, DvpCallerWallet>,
  counterpartyLabels: ReadonlyMap<string, string>
): PartyRef {
  const wallet = callerAddresses.get(address);
  if (counterpartyAccountId === null) {
    return {
      address,
      counterparty: null,
      wallet: wallet === undefined ? null : wallet,
    };
  }
  const label = counterpartyLabels.get(counterpartyAccountId);
  return {
    address,
    counterparty: label === undefined ? null : { id: counterpartyAccountId, label },
    wallet: wallet === undefined ? null : wallet,
  };
}

/**
 * The transaction that moved a leg into escrow: the receipt, else the live
 * claim's signature while the funding is in flight, else null. Claims rows
 * are tenant-scoped to the FUNDING org, so an unseen row simply reads null.
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
 * One leg, including what the reconciler last saw in its escrow. Derived here
 * because the rules are not obvious: settlement needs `observed >= target` on
 * BOTH legs, a surplus is a settlement RISK (settle refunds it, and on a
 * transfer-hook mint the refund can revert settlement), and null is "not
 * checked", not zero.
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
    /** The mint's decimals, or null when unknown — a wrong scale would misstate every amount. */
    decimals: leg.decimals,
    /** The mint's symbol, or null when it carries no metadata. Never invented. */
    symbol: leg.symbol,
    name: leg.name,
    /** Image of the leg's mint when it is a token this organization issued through SDP; null otherwise. */
    imageUrl: leg.imageUrl,
    /** Pay this address to fund the leg. */
    escrow: leg.escrow,
    settlementDestination: leg.settlementDestination,
    outcome: leg.outcome,
    funding,
    /** Which transaction funded this leg. @see {@link fundingSignatureFor} */
    fundingSignature,
  };
}

/** Everything a read derives for the caller, resolved ONCE per request. */
interface TradeReadContext {
  /** The caller's custody wallets (address → wallet identity). */
  callerAddresses: ReadonlyMap<string, DvpCallerWallet>;
  /** Creator-org counterparty names; empty on cross-org party reads (attribution is the creator's fact). */
  counterpartyLabels: ReadonlyMap<string, string>;
  /** This trade's funding claims, keyed by side. RLS-scoped to the funding org. */
  fundingClaims: ReadonlyMap<DvpTradeSide, DvpLegFundingClaim>;
  /** Issued-token image per mint for the requesting org/project; a mint it never issued is absent and reads as null. */
  mintImages: ReadonlyMap<string, string | null>;
}

/**
 * Wire shape of a trade. The escrows are what a counterparty pays into;
 * every 64-bit value stays a string (a JSON number rounds above 2^53).
 * The caller's standing (`party.wallet`, `kind`) is derived from
 * {@link TradeReadContext} and never stored.
 */
function toTradeResponse(row: DvpTradeRow, context: TradeReadContext) {
  const mintAImage = context.mintImages.get(row.mintA);
  const mintBImage = context.mintImages.get(row.mintB);
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
          name: row.nameA,
          imageUrl: mintAImage === undefined ? null : mintAImage,
          frozen: row.escrowAFrozen,
          outcome: deriveDvpLegOutcome(row, "a"),
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
          name: row.nameB,
          imageUrl: mintBImage === undefined ? null : mintBImage,
          frozen: row.escrowBFrozen,
          outcome: deriveDvpLegOutcome(row, "b"),
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
    /** The caller's standing, derived per caller. @see {@link deriveDvpTradeKind} */
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
 * Display names for the counterparties a set of trades attributes to — one
 * batched query for the page. Creator-org reads only; an archived account
 * simply does not resolve, and answers null.
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
 * The funding claims on one trade, keyed by side. One query per trade (N for
 * a page, acceptable at the documented limit of 100); not widened into a batch
 * because claim rows are RLS-scoped to the funding org, and unseen means null.
 */
async function readFundingClaims(
  env: Env,
  tradeId: string
): Promise<Map<DvpTradeSide, DvpLegFundingClaim>> {
  const claims = await createPostgresDvpLegFundingClaimRepository(getDb(env)).listForTrade(tradeId);
  return new Map(claims.map((claim) => [claim.side, claim]));
}

/**
 * The issued-token image behind each mint on the page, in one query.
 *
 * Scoped to the requesting organization/project: a mint this organization
 * never issued is absent, and the response builders read absence as null, so
 * another organization's issued token never lends its artwork across the
 * tenant boundary. Only the token record's own image column is consulted.
 *
 * @param env - The request environment (database access).
 * @param organizationId - The requesting organization, scoping every lookup.
 * @param projectId - The requesting project, scoping every lookup.
 * @param mints - Every mint on the page; duplicates are harmless.
 * @returns Mint to image URL for this tenant's issued tokens (null when the
 *   token has no artwork); mints it never issued are absent.
 */
function readMintImages(
  env: Env,
  organizationId: string,
  projectId: string,
  mints: string[]
): Promise<Map<string, string | null>> {
  return new TokenService(
    getDb(env),
    createTenantScope({ organizationId, projectId })
  ).listTokenImagesByMints(mints);
}

export const createTrade = async (c: ValidatedBodyContext<typeof createDvpTradeSchema>) => {
  const auth = getAuth(c);
  const projectId = requireProjectId(c);
  const body = c.req.valid("json");

  // Liveness first, for EVERY key. Create provisions the settlement wallet and
  // spends sponsored Kora budget on the project's behalf, even when both party
  // slots are pasted addresses, so a revoked key must not get that far on a
  // stale snapshot.
  await assertFreshApiKeyActive(getDb(c.env), auth);
  // A wallet-scoped key only SEES trades its bound wallets are party to, and
  // visibility filters on the READ scope — a binding can hold payments:write
  // without payments:read, so the guard checks read admission, not write. A
  // `{walletId}` slot is the explicit ownership claim; a pasted address that
  // happens to be a bound wallet's is not, and the remedy is naming it.
  const readAdmittedWalletIds = getAllowedApiKeyCustodyWalletIdsForPermissions(auth, [
    "payments:read",
  ]);
  if (
    readAdmittedWalletIds !== null &&
    !("walletId" in body.partyA && readAdmittedWalletIds.includes(body.partyA.walletId)) &&
    !("walletId" in body.partyB && readAdmittedWalletIds.includes(body.partyB.walletId))
  ) {
    throw forbidden(
      "A wallet-scoped key must name one of its wallets with payments:read as a party (a walletId slot) — the trade would otherwise be invisible to this key"
    );
  }
  const assertedWalletIds = [
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
  const [callerAddresses, counterpartyLabels, mintImages] = await Promise.all([
    callerPartyAddresses(c.env, { organizationId: auth.organizationId, projectId, auth }),
    readCounterpartyLabels(c.env, auth.organizationId, projectId, [trade]),
    readMintImages(c.env, auth.organizationId, projectId, [trade.mintA, trade.mintB]),
  ]);
  return success(
    c,
    {
      trade: toTradeResponse(trade, {
        callerAddresses,
        counterpartyLabels,
        fundingClaims: new Map<DvpTradeSide, DvpLegFundingClaim>(),
        mintImages,
      }),
    },
    201
  );
};

/**
 * Settles or cancels a trade. The policy gate has already run (denied = 403,
 * approval needed = 202); on an approved replay it re-runs with the same
 * resolved trade, which is why the gate resolves it rather than the handler.
 */
const closeTrade = (action: DvpCloseAction) => async (c: AppContext) => {
  const { resolved } = getPolicyGateContext<Record<string, unknown>, DvpCloseResolved>(c);
  if (!resolved.trade) {
    throw notFound("DvP trade not found");
  }

  // Re-read the binding before anything irreversible: the gate's auth context
  // can be an hour stale, and settling with a revoked key is an irreversible
  // two-leg spend, not a read slip. The wallet asserted is the SETTLEMENT
  // wallet — the one that signs; the liveness assert covers keys the
  // wallet-scoped check skips.
  await assertFreshApiKeyActive(getDb(c.env), getAuth(c));
  await assertFreshApiKeyCustodyWalletAccess(
    getDb(c.env),
    getAuth(c),
    resolved.settlement.custodyWalletId,
    ["payments:write"]
  );

  const result = await closeDvpTrade(c, resolved.trade, action);

  // We broadcast it, so we know the outcome — not `closed_unknown` from the sweep.
  await createDvpTradeRepository(c.env).recordClose(
    resolved.trade.id,
    action === "settle" ? "settled" : "cancelled",
    result.signature
  );

  await observeDvpTradeNow(c.env, resolved.trade, result.signature);

  return success(c, {
    tradeId: resolved.trade.id,
    action,
    signature: result.signature,
  });
};

/**
 * Funds one side of a trade. Same gate as settle and cancel: it spends from a
 * custody wallet, and the right to fund side X is holding an active custody
 * wallet whose public key equals `user_x`.
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
  const { side, approvedAmount } = resolved.funding;
  const partyAddress = side === "a" ? trade.userA : trade.userB;

  // PRE-BROADCAST RE-READ — the ticket's authorization invariant: re-derive
  // the wallet and re-assert the key's binding from the database (the gate's
  // resolution and auth context can both be an hour stale). Omitted
  // `walletId`, that is the custody lookup on the party address; explicit, it
  // is that the named wallet still holds the address (naming narrows).
  const rereadWalletId =
    body.walletId !== null && body.walletId !== undefined
      ? await walletIdIfHoldsAddress(c, body.walletId, partyAddress)
      : await custodyWalletForParty(
          c.env,
          { organizationId: auth.organizationId, projectId },
          partyAddress,
          getAllowedApiKeyCustodyWalletIdsForPermissions(auth, ["payments:write"])
        );
  if (rereadWalletId === null) {
    throw forbidden(
      `DvP trade ${trade.id}: no active custody wallet in this project holds the side ${side} party address`
    );
  }
  await assertFreshApiKeyActive(getDb(c.env), auth);
  await assertFreshApiKeyCustodyWalletAccess(getDb(c.env), auth, rereadWalletId, [
    "payments:write",
  ]);

  const result = await fundDvpTradeLeg(c, trade, {
    side,
    custodyWalletId: rereadWalletId,
    organizationId: auth.organizationId,
    projectId,
    approvedAmount,
  });

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
 * Trades somebody else created that are waiting on this caller. No parameters,
 * deliberately: the filter is the caller's own custody addresses, resolved
 * server-side — accepting a party address would make this an oracle for any
 * Solana address's trades. Uses its own serializer because `toTradeResponse`
 * carries the creating org's fields.
 */
export const listInboundTrades = async (c: AppContext) => {
  const auth = getAuth(c);
  const projectId = requireProjectId(c);

  const inbound = await listInboundDvpTrades(c.env, {
    organizationId: auth.organizationId,
    projectId,
    auth,
  });

  // Once for the page, scoped to the CALLER's organization like every other
  // read here: the party sees its own issued tokens' artwork, never the
  // creating org's.
  const mintImages = await readMintImages(
    c.env,
    auth.organizationId,
    projectId,
    inbound.trades.flatMap((entry) => [entry.trade.mintA, entry.trade.mintB])
  );

  return success(c, {
    trades: inbound.trades.map((trade) =>
      toDvpInboundResponse(trade, inbound.callerAddresses, mintImages)
    ),
  });
};

export const listTrades = async (c: AppContext) => {
  const auth = getAuth(c);
  const projectId = requireProjectId(c);

  const query = listDvpTradesQuerySchema.safeParse({
    limit: c.req.query("limit"),
    status: c.req.query("status"),
    q: c.req.query("q"),
  });
  if (!query.success) {
    const issue = query.error.issues[0];
    // A bad status value names itself and the allowed set, the issuance
    // transactions convention; every other failure is the limit's message.
    if (issue.path[0] === "status") {
      throw badRequest("Invalid status query parameter", {
        allowedStatuses: DVP_TRADE_STATUSES,
      });
    }
    throw badRequest(
      issue.path[0] === "q"
        ? "Invalid q query parameter: expected a search string of 2 to 100 characters"
        : "Invalid limit: expected an integer between 1 and 100"
    );
  }

  const trades = await createDvpTradeRepository(c.env).listByProject(
    {
      organizationId: auth.organizationId,
      projectId,
      sdpWalletIds: readableSdpWalletIds(c),
    },
    {
      statuses: query.data.status === undefined ? null : query.data.status,
      q: query.data.q === undefined || query.data.q === "" ? null : query.data.q,
    },
    query.data.limit
  );

  // Resolved once for the page; claims stay index-aligned with the trades.
  const [callerAddresses, counterpartyLabels, fundingClaimsByTrade, mintImages] = await Promise.all(
    [
      callerPartyAddresses(c.env, { organizationId: auth.organizationId, projectId, auth }),
      readCounterpartyLabels(c.env, auth.organizationId, projectId, trades),
      Promise.all(trades.map((trade) => readFundingClaims(c.env, trade.id))),
      readMintImages(
        c.env,
        auth.organizationId,
        projectId,
        trades.flatMap((trade) => [trade.mintA, trade.mintB])
      ),
    ]
  );
  return success(c, {
    trades: trades.map((trade, index) =>
      toTradeResponse(trade, {
        callerAddresses,
        counterpartyLabels,
        fundingClaims: fundingClaimsByTrade[index],
        mintImages,
      })
    ),
  });
};

export const getTrade = async (c: AppContext) => {
  const auth = getAuth(c);
  const projectId = requireProjectId(c);
  const tradeId = c.req.param("tradeId");
  if (!tradeId) {
    throw notFound("DvP trade not found");
  }

  // Out-of-scope trades 404 like unknown ones, so nothing leaks about which exist.
  const trade = await createDvpTradeRepository(c.env).getById(
    {
      organizationId: auth.organizationId,
      projectId,
      sdpWalletIds: readableSdpWalletIds(c),
    },
    tradeId
  );
  // Not ours, but possibly ours to READ: a party on another org's trade can
  // see it (0089) — without this fallback the inbound link would 404.
  if (!trade) {
    return respondWithPartyTrade(c, tradeId);
  }

  // Re-read a trade whose stored reading aged out for its status: open trades
  // every few seconds, closed ones once a minute for late deposits.
  const observed = await observeDvpTradeIfStale(c.env, trade);

  const [callerAddresses, counterpartyLabels, fundingClaims, mintImages] = await Promise.all([
    callerPartyAddresses(c.env, { organizationId: auth.organizationId, projectId, auth }),
    readCounterpartyLabels(c.env, auth.organizationId, projectId, [observed]),
    readFundingClaims(c.env, observed.id),
    readMintImages(c.env, auth.organizationId, projectId, [observed.mintA, observed.mintB]),
  ]);
  return success(c, {
    trade: {
      ...toTradeResponse(observed, {
        callerAddresses,
        counterpartyLabels,
        fundingClaims,
        mintImages,
      }),
    },
  });
};

/**
 * Which side of another org's trade this caller is party to, if any: a side
 * is the caller's iff an active custody wallet of theirs holds its party
 * address. Answers for the ORGANIZATION; callers layer key scope on top.
 */
async function resolveYourSide(
  c: AppContext,
  trade: DvpTradeRow,
  projectId: string
): Promise<{ side: "a" | "b"; custodyWalletId: string } | null> {
  const org = { organizationId: getAuth(c).organizationId, projectId };
  const walletForA = await custodyWalletForParty(c.env, org, trade.userA, null);
  if (walletForA !== null) {
    return { side: "a", custodyWalletId: walletForA };
  }
  const walletForB = await custodyWalletForParty(c.env, org, trade.userB, null);
  if (walletForB !== null) {
    return { side: "b", custodyWalletId: walletForB };
  }
  return null;
}

/**
 * The same page, for a party who is not the trade's author: the detail
 * shape with the creating org's facts (attribution and funding claims)
 * withheld. 404 when they are not a party, matching the read above.
 */
async function respondWithPartyTrade(c: AppContext, tradeId: string) {
  const auth = getAuth(c);
  const projectId = requireProjectId(c);

  const trade = await createDvpTradeRepository(c.env).getByIdAsParty(tradeId);
  if (!trade) {
    throw notFound("DvP trade not found");
  }

  // This path is for a trade ANOTHER org created; reaching it for our own is
  // the scoped lookup refusing a wallet-scoped key, and answering here would
  // launder the trade past its scope. `getByIdAsParty` is deliberately
  // unfiltered and leans on RLS 0089, which enforces nothing in tests, so
  // BOTH this guard and the key-scope check below are load-bearing.
  if (trade.organizationId === auth.organizationId) {
    throw notFound("DvP trade not found");
  }

  const fundable = await resolveYourSide(c, trade, projectId);
  if (!fundable) {
    throw notFound("DvP trade not found");
  }

  // Key-scope filtering on the ORGANIZATION-level resolution, or the fallback
  // would hand the trade to a key bound to a different wallet. Same 404.
  const scopedWalletIds = readableSdpWalletIds(c);
  if (scopedWalletIds !== null && !scopedWalletIds.includes(fundable.custodyWalletId)) {
    throw notFound("DvP trade not found");
  }

  // Read, not recorded: persisting would UPDATE another org's row (0089).
  const observed = await observeDvpTradeWithoutRecording(c.env, trade);

  // Derived from the caller's OWN wallets, like any other view. Labels are
  // never resolved (attribution is the creator's fact); claims ARE read, and
  // claim-row RLS scopes them to the funding org. The mint images resolve
  // against the CALLER's organization too, so the creator's issued token never
  // lends its artwork across the tenant boundary.
  const [callerAddresses, fundingClaims, mintImages] = await Promise.all([
    callerPartyAddresses(c.env, {
      organizationId: auth.organizationId,
      projectId,
      auth,
    }),
    readFundingClaims(c.env, observed.id),
    readMintImages(c.env, auth.organizationId, projectId, [observed.mintA, observed.mintB]),
  ]);

  return success(c, {
    trade: {
      ...toTradeResponse(observed, {
        callerAddresses,
        counterpartyLabels: new Map<string, string>(),
        fundingClaims,
        mintImages,
      }),
      // Theirs, not ours: a party gets the trade without the creator's fields.
      refString: null,
      /** Which leg is the reader's, so the page can say so. */
      yourSide: fundable.side,
    },
  });
}

/**
 * Inspects a mint so the create form can take a human amount for it: public
 * chain state, answered BEFORE a trade is signed or costs a signature.
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
