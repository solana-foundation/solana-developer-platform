/**
 * What a party is told about a trade somebody else created.
 *
 * Written from scratch rather than reusing `toTradeResponse`, which speaks to
 * the creating org and carries fields belonging to it. The rule: the CHAIN's
 * facts cross (everything below a PDA holder can already decode), ours do not.
 * Deliberately absent — `organizationId`/`projectId`, `refString`, `sdpWallet`,
 * counterparty attribution (a fact about the CREATING org, so always null),
 * funding claims (tenant-scoped, so null by construction), the derived `kind`
 * (`wallet` + `yourSide` convey standing), and `idempotencyKey`.
 * `symbolA`/`symbolB` ARE included; they are read off the mint on chain.
 */

import type { DvpLegOutcome } from "@sdp/types";
import type { DvpCallerWallet, DvpInboundTrade } from "@/services/dvp/inbound";
import { deriveDvpLegOutcome } from "@/services/dvp/leg-outcome";

/** One party of the trade, as a party who is not the author may see it. */
interface DvpInboundPartyResponse {
  address: string;
  /** Never attributed: it belongs to the creating org, which the viewer is not. */
  counterparty: null;
  /** The caller's custody wallet holding this address, or null. Truthy = the caller custodies this party. */
  wallet: DvpCallerWallet | null;
}

/** One leg, as a party who is not the author may see it. */
interface DvpInboundLegResponse {
  party: DvpInboundPartyResponse;
  mint: string;
  tokenProgram: string;
  amount: string;
  decimals: number | null;
  symbol: string | null;
  /** The mint's human name, or null when it carries no metadata. */
  name: string | null;
  /** Image of the leg's mint when it is a token this organization issued through SDP; null otherwise. */
  imageUrl: string | null;
  /** The address to pay. The whole of this party's integration. */
  escrow: string;
  /** Where this leg's proceeds land. On chain, and worth checking before paying. */
  settlementDestination: string;
  /** Last observed escrow balance, or null before the reconciler has looked. */
  observedAmount: string | null;
  /** Null when the reconciler has not looked yet, which is not the same as thawed. */
  frozen: boolean | null;
  outcome: DvpLegOutcome;
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
 * One leg's party as a party viewer sees it: address and `wallet`, never
 * attribution.
 *
 * @param address - The party address on the wire.
 * @param callerAddresses - The caller's custody wallets (address → wallet identity).
 * @returns The party object the inbound response carries.
 */
function inboundParty(
  address: string,
  callerAddresses: ReadonlyMap<string, DvpCallerWallet>
): DvpInboundPartyResponse {
  const wallet = callerAddresses.get(address);
  return { address, counterparty: null, wallet: wallet === undefined ? null : wallet };
}

/**
 * Serializes one inbound trade for the party that is named on it.
 *
 * @param inbound - The trade, the caller's side on it, and their matching address.
 * @param callerAddresses - The caller's custody wallets (address → wallet identity).
 * @param mintImages - Each mint's issued-token image resolved for the CALLER's
 *   organization, so the creator's issued token never lends it artwork.
 * @returns The wire shape a party viewer receives.
 */
export function toDvpInboundResponse(
  inbound: DvpInboundTrade,
  callerAddresses: ReadonlyMap<string, DvpCallerWallet>,
  mintImages: ReadonlyMap<string, string | null>
): DvpInboundTradeResponse {
  const { trade, side, party } = inbound;
  const mintAImage = mintImages.get(trade.mintA);
  const mintBImage = mintImages.get(trade.mintB);

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
        name: trade.nameA,
        imageUrl: mintAImage === undefined ? null : mintAImage,
        escrow: trade.escrowA,
        settlementDestination: trade.userASettlementDestination,
        observedAmount: trade.escrowAAmount,
        frozen: trade.escrowAFrozen,
        outcome: deriveDvpLegOutcome(trade, "a"),
      },
      b: {
        party: inboundParty(trade.userB, callerAddresses),
        mint: trade.mintB,
        tokenProgram: trade.tokenProgramB,
        amount: trade.amountB,
        decimals: trade.decimalsB,
        symbol: trade.symbolB,
        name: trade.nameB,
        imageUrl: mintBImage === undefined ? null : mintBImage,
        escrow: trade.escrowB,
        settlementDestination: trade.userBSettlementDestination,
        observedAmount: trade.escrowBAmount,
        frozen: trade.escrowBFrozen,
        outcome: deriveDvpLegOutcome(trade, "b"),
      },
    },
    expiryTimestamp: trade.expiryTimestamp,
    earliestSettlementTimestamp: trade.earliestSettlementTimestamp,
    createdAt: trade.createdAt,
    observedAt: trade.observedAt,
  };
}
