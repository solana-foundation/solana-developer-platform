import type { CustodyWalletTokenBalance } from "@sdp/types";

interface TokenNamedRow {
  token: string;
  tokenMint: string | null;
}

/**
 * The mint→symbol map the home activity table resolves names against.
 *
 * Balances are the better source when they have the mint: they carry a live symbol for
 * every token the organization currently holds, including ones the shared catalogue has
 * never heard of.
 *
 * Rows are folded in first, and they matter for the mints balances *cannot* cover. An
 * issuance row carries the authoritative `token.symbol`, and resolving its mint against
 * balances alone fell through to a shortened mint — which is a truthy string, so it beat
 * the good symbol the row already had rather than letting the caller fall back to it.
 * That turned the old "raw base58 in the Token column" bug into a subtler one: a real
 * symbol replaced by `4zMMC9srt5…` for any token the organization no longer holds.
 *
 * A row contributes nothing when it has no mint, when its token is the `—` placeholder,
 * or when the "symbol" is just the mint again — none of those name anything.
 */
export function buildTokenSymbolsByMint(
  rows: readonly TokenNamedRow[],
  balances: readonly CustodyWalletTokenBalance[]
): Record<string, string> {
  return Object.fromEntries([
    ...rows.flatMap((row) =>
      row.tokenMint && row.token !== "—" && row.token !== row.tokenMint
        ? [[row.tokenMint, row.token] as const]
        : []
    ),
    ...balances.map((balance) => [balance.mint, balance.token] as const),
  ]);
}
