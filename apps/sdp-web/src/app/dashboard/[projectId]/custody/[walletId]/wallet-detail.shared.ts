import type { CustodyWalletTokenBalance } from "@sdp/types";
import type { KnownCustodyProvider } from "@/app/dashboard/[projectId]/custody/provider-catalog";
/** The Transactions ledger narrowed to one wallet, where its whole history pages. */
export function walletTransactionsHref(custodyWalletId: string): string {
  return `/dashboard/payments/transactions?${new URLSearchParams({ custodyWalletId })}`;
}

/** The transfer or transaction id the row carries, without the feed's source prefix. */
export function activityDisplayId(id: string): string {
  const bare = id.replace(/^(payment|issuance)-/, "");
  return bare.length > 14 ? `${bare.slice(0, 8)}…${bare.slice(-4)}` : bare;
}

/** What the wallet's page shows about the wallet itself, resolved on the server. */
export interface WalletPageView {
  walletId: string;
  /** The custody record's own id, which the Transactions ledger filters by. */
  custodyWalletId: string;
  /** The label, or "Untitled wallet". */
  name: string;
  publicKey: string;
  provider: KnownCustodyProvider | null;
  /** The provider's own name, or the raw provider id when the catalogue does not know it. */
  providerName: string;
  purposeLabel: string | null;
  createdAt: string | null;
  isRuntimeExecutionAllowed: boolean;
  supportsSignerCheck: boolean;
  /** The provider connection it signs through, linked for an admin where BYOK is on. */
  connection: { label: string; href: string | null } | null;
  canManageCustody: boolean;
  label: string | null;
}

export interface WalletBalancesResult {
  balances: CustodyWalletTokenBalance[];
  error: string | null;
}

/** Tokens this organization issued, by mint: their names in balances and activity. */
export type IssuedTokensByMint = Record<
  string,
  { id: string; name: string | null; symbol: string | null }
>;

/** The page's tabs, in order. */
export const WALLET_TABS = ["overview", "activity", "settings"] as const;
export type WalletTab = (typeof WALLET_TABS)[number];

/**
 * Symbols by mint for naming amounts: the tokens this organization issued, then what the
 * balances call them (a balance's "symbol" that is only its mint again says nothing).
 */
export function symbolsByMint(
  balances: readonly CustodyWalletTokenBalance[],
  issued: IssuedTokensByMint
): Record<string, string> {
  const symbols: Record<string, string> = {};
  for (const [mint, token] of Object.entries(issued)) {
    if (token.symbol) symbols[mint] = token.symbol;
  }
  for (const balance of balances) {
    const mint = balance.mint?.trim();
    const token = balance.token?.trim();
    if (mint && token && token !== mint) symbols[mint] = token;
  }
  return symbols;
}
