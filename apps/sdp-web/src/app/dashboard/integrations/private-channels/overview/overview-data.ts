import type { PrivateChannelDto, PrivateChannelEventDto } from "@sdp/types";
import { WELL_KNOWN_TOKEN_BY_MINT } from "@sdp/types";
import type { WalletChannelBalance } from "../private-channels-page.data";

/** A mint the connected member holds a channel balance in. */
export interface MintBalance {
  mint: string;
  /** Ticker resolved from the well-known catalogue, or null for an unknown mint. */
  symbol: string | null;
  /** Summed base-unit balance across the member's verified wallets. */
  base: bigint;
  decimals: number;
}

/**
 * Sum each mint's channel balance across the member's verified wallets.
 *
 * Balances arrive per (wallet, mint); the overview shows one figure per mint, so
 * they're summed here. Summation is on the raw base-unit integers (never the
 * pre-formatted decimal strings) to avoid float drift, then formatted once.
 */
export function aggregateBalancesByMint(
  balances: Record<string, WalletChannelBalance>
): MintBalance[] {
  const byMint = new Map<string, { base: bigint; decimals: number }>();
  for (const balance of Object.values(balances)) {
    const existing = byMint.get(balance.mint);
    const base = safeBigInt(balance.amount);
    if (existing) {
      existing.base += base;
    } else {
      byMint.set(balance.mint, { base, decimals: balance.decimals });
    }
  }
  return [...byMint.entries()].map(([mint, value]) => ({
    mint,
    symbol: WELL_KNOWN_TOKEN_BY_MINT.get(mint)?.symbol ?? null,
    base: value.base,
    decimals: value.decimals,
  }));
}

/** Format a base-unit integer as a grouped decimal string (trailing zeros trimmed). */
export function formatTokenAmount(base: bigint, decimals: number): string {
  const negative = base < 0n;
  const abs = negative ? -base : base;
  const divisor = 10n ** BigInt(decimals);
  const whole = (abs / divisor).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const fraction =
    decimals > 0 ? (abs % divisor).toString().padStart(decimals, "0").replace(/0+$/, "") : "";
  const value = fraction ? `${whole}.${fraction}` : whole;
  return negative ? `-${value}` : value;
}

/** Map channel id → display name, for resolving an event's channelId. */
export function channelNameById(channels: PrivateChannelDto[]): Record<string, string> {
  return Object.fromEntries(channels.map((channel) => [channel.id, channel.name]));
}

/**
 * The mint an event concerns, if any. Financial events (deposit/withdraw/transfer)
 * carry `mint` in their payload; lifecycle/member events don't — those get no token.
 */
export function eventMint(event: PrivateChannelEventDto): string | null {
  const mint = event.payload?.mint;
  return typeof mint === "string" && mint.length > 0 ? mint : null;
}

function safeBigInt(value: string): bigint {
  try {
    return BigInt(value);
  } catch {
    return 0n;
  }
}
