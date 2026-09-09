/**
 * What a party is told about a trade somebody else created.
 *
 * Written from scratch rather than reusing `toTradeResponse`, and that is the
 * point of the file. That serializer speaks to the organization that created
 * the trade and carries things which belong to it: `sdpWallet`, `refString`,
 * the settlement authority's funding readiness. Reaching for it here and
 * deleting fields afterwards would put the disclosure decision in whatever
 * shape that response happens to have next month.
 *
 * The rule this encodes: the CHAIN's facts cross, ours do not.
 *
 * Everything below is already readable by anyone holding the trade's PDA, using
 * the checked decoders in `@sdp/dvp` — the parties, the mints, the amounts, the
 * escrow addresses, the expiry. Telling a named party about a trade that names
 * it discloses nothing it was not already entitled to read, which is why the
 * 0089 policy is safe.
 *
 * Deliberately absent, each because it is ours and not the chain's:
 *
 * - `organizationId` / `projectId` — who set the trade up. A party is entitled
 *   to know the terms, not to learn which SDP customer wrote them.
 * - `refString` — the creating org's own reference for its own records.
 * - `sdpWallet` — that org's custody wallet address and its label.
 * - Counterparty attribution — which registered counterparty a party is is a
 *   fact about the CREATING organization; a viewer on inbound is never that
 *   org, so `party.counterparty` is always null here.
 * - Funding claims — tenant-scoped to the funding organization, so a party
 *   read answers null for them by construction.
 * - `tradeKind` / the derived `kind` — standing is conveyed by `custodied` on
 *   each leg and by `yourSide`, not by a stored or derived label.
 * - `idempotencyKey`, and the fingerprint derived from it.
 * - `settlementReadiness` — whether their settlement authority holds enough
 *   SOL is an operational fact about their deployment.
 * - `symbolA` / `symbolB` are included; they are read off the mint on chain.
 */

import type { DvpInboundTrade } from "@/services/dvp/inbound";

/** One party of the trade, as a party who is not the author may see it. */
interface DvpInboundPartyResponse {
  address: string;
  /**
   * Never attributed: which registered counterparty a party is belongs to the
   * creating organization, and the viewer on inbound is never that org.
   */
  counterparty: null;
  /** Whether the CALLER holds an active custody wallet for this address. */
  custodied: boolean;
}

/** One leg, as a party who is not the author may see it. */
interface DvpInboundLegResponse {
  party: DvpInboundPartyResponse;
  mint: string;
  tokenProgram: string;
  amount: string;
  decimals: number | null;
  symbol: string | null;
  /** The address to pay. The whole of this party's integration. */
  escrow: string;
  /** Where this leg's proceeds land. On chain, and worth checking before paying. */
  settlementDestination: string;
  /** Last observed escrow balance, or null before the reconciler has looked. */
  observedAmount: string | null;
  /** Null when the reconciler has not looked yet, which is not the same as thawed. */
  frozen: boolean | null;
}

export interface DvpInboundTradeResponse {
  id: string;
  status: string;
  /** The on-chain account, so the party can verify every term independently. */
  swapDvp: string;
  settlementAuthority: string;
  /** Which leg is the caller's. */
  yourSide: "a" | "b";
  /** The caller's own address that made this trade theirs. */
  yourParty: string;
  legs: { a: DvpInboundLegResponse; b: DvpInboundLegResponse };
  expiryTimestamp: string;
  earliestSettlementTimestamp: string | null;
  createdAt: string;
  /** When the escrow balances below were last confirmed against the chain. */
  observedAt: string | null;
}

/**
 * One leg's party as a party viewer sees it: the address and whether the
 * CALLER holds a custody wallet for it, never attribution.
 *
 * @param address - The party address on the leg.
 * @param callerAddresses - The caller's custody wallet addresses, the same map
 *   membership was derived from — an inbound trade has at least one custodied
 *   side by construction, and both legs can be custodied when the caller holds
 *   both addresses.
 */
function inboundParty(
  address: string,
  callerAddresses: ReadonlyMap<string, string>
): DvpInboundPartyResponse {
  return { address, counterparty: null, custodied: callerAddresses.has(address) };
}

export function toDvpInboundResponse(
  inbound: DvpInboundTrade,
  callerAddresses: ReadonlyMap<string, string>
): DvpInboundTradeResponse {
  const { trade, side, party } = inbound;

  return {
    id: trade.id,
    status: trade.status,
    swapDvp: trade.swapDvp,
    settlementAuthority: trade.settlementAuthority,
    yourSide: side,
    yourParty: party,
    legs: {
      a: {
        party: inboundParty(trade.userA, callerAddresses),
        mint: trade.mintA,
        tokenProgram: trade.tokenProgramA,
        amount: trade.amountA,
        decimals: trade.decimalsA,
        symbol: trade.symbolA,
        escrow: trade.escrowA,
        settlementDestination: trade.userASettlementDestination,
        observedAmount: trade.escrowAAmount,
        frozen: trade.escrowAFrozen,
      },
      b: {
        party: inboundParty(trade.userB, callerAddresses),
        mint: trade.mintB,
        tokenProgram: trade.tokenProgramB,
        amount: trade.amountB,
        decimals: trade.decimalsB,
        symbol: trade.symbolB,
        escrow: trade.escrowB,
        settlementDestination: trade.userBSettlementDestination,
        observedAmount: trade.escrowBAmount,
        frozen: trade.escrowBFrozen,
      },
    },
    expiryTimestamp: trade.expiryTimestamp,
    earliestSettlementTimestamp: trade.earliestSettlementTimestamp,
    createdAt: trade.createdAt,
    observedAt: trade.observedAt,
  };
}
