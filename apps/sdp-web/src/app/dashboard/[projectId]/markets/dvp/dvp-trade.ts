/**
 * The DvP trade shape the dashboard consumes, and the derivations it needs.
 *
 * Every 64-bit value is a string here for the same reason it is one on the
 * wire: amounts and the nonce are u64 on chain, and a JS number rounds above
 * 2^53. Comparisons go through BigInt, never Number.
 */

import {
  DVP_LEG_TRANSFER_KINDS,
  DVP_TRADE_SIDES,
  type DvpLegOutcome,
  type DvpLegTransferKind,
  type DvpSettlementAvailability,
  type DvpTradeSide,
  type DvpTradeStatus,
} from "@sdp/types";
import { z } from "zod";

export type { DvpLegTransferKind, DvpSettlementAvailability, DvpTradeStatus };

/**
 * The caller's standing on a trade, derived per caller by the API.
 *
 * Display copy only, never a term of the trade: 0 custodied sides is an agent
 * trade (the terms were set for two other parties), 1 is principal, 2 is
 * bilateral. Never re-derived client-side — trust the wire.
 */
export type DvpTradeKind = "principal" | "agent" | "bilateral";

/**
 * The caller's custody wallet behind a party address, as the API resolves it.
 * `name` is the wallet's display name, or null when none was set.
 */
export interface DvpCallerWallet {
  id: string;
  name: string | null;
}

export const dvpActionWalletSchema = z.object({
  id: z.string().min(1),
  name: z.string().nullable(),
  isRuntimeExecutionAllowed: z.boolean(),
});

export type DvpActionWallet = z.infer<typeof dvpActionWalletSchema>;

/**
 * A DvP endpoint's refusal envelope. Only the message — and, when the refusal
 * is a structured one, its reason code — is ever read by the dashboard;
 * everything else the API attached is stripped.
 */
export const dvpErrorEnvelopeSchema = z.object({
  error: z.object({
    message: z.string(),
    details: z.object({ reason: z.string() }).partial().optional(),
  }),
});

/** One side of a trade as the API resolves it for the caller. */
export interface DvpPartyRef {
  address: string;
  /**
   * The creator's registered counterparty this party is, or null for an
   * external address. Never populated on a party read of another org's trade.
   */
  counterparty: { id: string; label: string } | null;
  /**
   * The caller's custody wallet holding this address, or null. Truthy = the
   * caller custodies this party; the id is the wallet page's identifier.
   */
  wallet: DvpCallerWallet | null;
  /** Present on action-bearing reads; null means no readable funding target. */
  actionWallet?: DvpActionWallet | null;
}

/**
 * One token movement in or out of a leg's escrow, read off the chain. Parsed at
 * the card rather than trusted: the dashboard and the API deploy separately.
 */
const dvpLegTransferSchema = z.object({
  signature: z.string().min(1),
  direction: z.enum(["in", "out"]),
  /** What the movement was, named by the API from the trade's close. */
  kind: z.enum(DVP_LEG_TRANSFER_KINDS),
  /** Base units moved, always positive. */
  amount: z.string().regex(/^[1-9]\d*$/),
  slot: z.string(),
  /** When the block was produced, or null when the cluster recorded no time. */
  blockTime: z.string().nullable(),
  feePayer: z.string(),
});

export type DvpLegTransfer = z.infer<typeof dvpLegTransferSchema>;

export interface DvpTradeLeg {
  /** The mint's decimals, or null when unknown. Never guessed. */
  decimals: number | null;
  /** The mint's symbol, or null when it carries no metadata. */
  symbol: string | null;
  name: string | null;
  /** Image of the leg's mint when it is a token this organization issued through SDP; null otherwise. */
  imageUrl: string | null;
  party: DvpPartyRef;
  mint: string;
  tokenProgram: string;
  amount: string;
  /** The address a counterparty pays into. The whole of their integration. */
  escrow: string;
  settlementDestination: string;
  funding: DvpLegFunding | null;
  /**
   * The transfer SDP broadcast into this escrow, once it is on the wire. Null
   * before that, and for deposits made outside SDP. Never the pre-broadcast claim.
   */
  fundingSignature: string | null;
  outcome: DvpLegOutcome;
  /** Every recorded movement in and out of the escrow, oldest first. Unvalidated wire data. */
  transfers: unknown;
}

/**
 * A leg's transfers, or null when the answer cannot be read. Null is not "no
 * transfers": the card shows none rather than claiming nothing moved.
 */
export function legTransfers(leg: DvpTradeLeg): DvpLegTransfer[] | null {
  const parsed = z.array(dvpLegTransferSchema).safeParse(leg.transfers);
  return parsed.success ? parsed.data : null;
}

export interface DvpTrade {
  id: string;
  status: DvpTradeStatus;
  kind: DvpTradeKind;
  swapDvp: string;
  settlementAuthority: string;
  legs: { a: DvpTradeLeg; b: DvpTradeLeg };
  nonce: string;
  expiryTimestamp: string;
  earliestSettlementTimestamp: string | null;
  /**
   * Whether Settle can go out, derived by the API from the cluster clock read
   * with the last observation. The badge, the list filter and the Settle panel
   * all read this rather than a browser clock. Null for a closed trade, or a
   * funded one not yet observed with a cluster clock.
   */
  settlementAvailability: DvpSettlementAvailability | null;
  refString: string | null;
  createSignature: string | null;
  closeSignature: string | null;
  observedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /**
   * Set only when the caller is a PARTY to a trade somebody else created.
   *
   * Absent on every trade this organization created. The API derives it from
   * the same custody lookup that sets each leg's `wallet`; `wallet`
   * itself stays the source for per-leg rendering.
   */
  yourSide?: DvpTradeSide;
}

/** Statuses where the trade is over and its escrows no longer exist on chain. */
const CLOSED_STATUSES: ReadonlySet<DvpTradeStatus> = new Set([
  "settled",
  "cancelled",
  "rejected",
  "closed_unknown",
  "create_failed",
]);

/** Whether the trade is finished and its escrows can no longer receive funds. */
export function isDvpTradeClosed(trade: { status: DvpTradeStatus }): boolean {
  return CLOSED_STATUSES.has(trade.status);
}

/** What the reconciler last saw in an escrow. Null before it has looked. */
export interface DvpLegFunding {
  observedAmount: string;
  funded: boolean;
  /** Amount above the target, or null. A settlement risk, not a bonus. */
  surplus: string | null;
  frozen: boolean;
}

/**
 * Whether the reader holds a leg of a trade somebody ELSE created.
 *
 * The API answers this with `yourSide` on party reads. Distinct from a
 * principal trade this org created itself: both hold a leg, only the latter
 * is the settlement authority.
 */
export function isDvpPartyView(trade: { yourSide?: DvpTradeSide }): boolean {
  return trade.yourSide === "a" || trade.yourSide === "b";
}

/**
 * The sides of a trade the CALLER holds a custody wallet for, A first.
 *
 * The one place the dashboard is allowed to read `party.wallet` into a
 * side list: fund actions render per custodied side, bilateral included.
 */
export function custodiedSidesOf(trade: Pick<DvpTrade, "legs">): DvpTradeSide[] {
  return DVP_TRADE_SIDES.filter((side) => trade.legs[side].party.wallet !== null);
}

/** Statuses a trade can still be settled or cancelled from. */
const OPEN: ReadonlySet<DvpTradeStatus> = new Set([
  "created",
  "partially_funded",
  "funded",
  "expired",
]);

/**
 * Whether a trade can still move: the statuses a settle or cancel is reachable
 * from, and the ones a leg's funding or reclaim actions answer to. The detail
 * page's per-leg gates read this rather than re-spelling the set.
 */
export function isDvpTradeOpen(trade: { status: DvpTradeStatus }): boolean {
  return OPEN.has(trade.status);
}

export function canCancelDvpTrade(trade: DvpTrade): boolean {
  return isDvpTradeOpen(trade);
}

/** Legs holding more than their target. Settle refunds the surplus. */
export function overFundedLegs(trade: DvpTrade): DvpTradeLeg[] {
  return [trade.legs.a, trade.legs.b].filter((leg) => leg.funding?.surplus != null);
}

/** Legs whose escrow is frozen, so funding transfers into them bounce. */
export function frozenLegs(trade: DvpTrade): DvpTradeLeg[] {
  return [trade.legs.a, trade.legs.b].filter((leg) => leg.funding?.frozen === true);
}

/**
 * Funding progress as a 0..1 fraction, or null when nothing has been observed.
 *
 * Capped at 1 rather than allowed to exceed it: an over-funded leg is fully
 * funded plus a separate warning, and a bar running past its track would read
 * as "more progress" when it actually means "a settlement risk".
 */
export function legFundingRatio(leg: DvpTradeLeg): number | null {
  if (!leg.funding) {
    return null;
  }
  const target = BigInt(leg.amount);
  if (target === 0n) {
    return 1;
  }
  const observed = BigInt(leg.funding.observedAmount);
  if (observed >= target) {
    return 1;
  }
  // Scale before converting so the ratio survives values above 2^53.
  return Number((observed * 10_000n) / target) / 10_000;
}

/**
 * A leg amount in the units a person entered it in.
 *
 * Shared by the list and the detail view. It lived in the detail view first,
 * which is how the list went on showing 1000000000 after the detail view
 * stopped: one formatter, or the next surface gets it wrong too.
 *
 * Falls back to the raw base units when the scale is unknown, which is honest:
 * a trade created before decimals were stored has no scale, and inventing one
 * would misstate the amount by orders of magnitude. Grouped so a long integer
 * stays readable either way.
 */
export function formatLegAmount(baseUnits: string, decimals: number | null): string {
  if (decimals === null) {
    return baseUnits;
  }
  const negative = baseUnits.startsWith("-");
  const digits = (negative ? baseUnits.slice(1) : baseUnits).padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = decimals === 0 ? "" : digits.slice(digits.length - decimals).replace(/0+$/, "");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "-" : ""}${grouped}${fraction ? `.${fraction}` : ""}`;
}

/**
 * "100 USDC", or just "100" for a mint without a symbol. The amount and the
 * symbol can come from different rows (a leg transfer carries its own
 * amount), so they are taken as separate arguments.
 */
export function formatLegAmountWithSymbol(
  baseUnits: string,
  decimals: number | null,
  symbol: string | null
): string {
  return `${formatLegAmount(baseUnits, decimals)}${symbol ? ` ${symbol}` : ""}`;
}

/**
 * A u64-seconds wire timestamp as an ISO instant, for `formatTimestamp`.
 * One expression, three surfaces: the conversion spelled inline is how an
 * expiry once rendered in microseconds.
 */
export function dvpTimestampToIso(seconds: string): string {
  return new Date(Number(seconds) * 1000).toISOString();
}

/**
 * Whether a value matches what somebody typed into the trade search.
 *
 * Plain substring, plus one case that plain substring gets wrong: this table
 * shows addresses SHORTENED — `BMiuAa…w1eP` — and the first thing anyone does
 * when hunting for a trade is select the address they can see and paste it in.
 * That matched nothing, because the only thing being searched was the full
 * forty-four characters. The UI was showing one string and searching another.
 *
 * So an ellipsis in the query is read as "starts with this, ends with that".
 * Both the character the table renders (…) and the three dots people type
 * count, because the two are indistinguishable to whoever pasted it.
 *
 * @param value - The full value being searched, e.g. an address or a symbol.
 * @param needle - The query, already trimmed and lowercased.
 */
export function matchesAddressQuery(value: string, needle: string): boolean {
  const haystack = value.toLowerCase();
  if (haystack.includes(needle)) {
    return true;
  }

  const [head, ...rest] = needle.split(/\u2026|\.\.\./);
  const tail = rest.join("");
  // Only when the query is genuinely a shortened address. A bare ellipsis, or
  // one with nothing on a side, would otherwise match every row.
  if (rest.length === 0 || !head || !tail) {
    return false;
  }
  return haystack.startsWith(head) && haystack.endsWith(tail);
}
