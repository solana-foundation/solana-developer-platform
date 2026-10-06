"use client";

import type { CustodyWalletTokenBalance } from "@sdp/types";
import Link from "next/link";
import useSWR from "swr";
import { custodyQueryKeys } from "@/app/dashboard/custody/custody-query-key";
import {
  BALANCE_REFRESH_INTERVAL_MS,
  fetchWalletBalance,
} from "@/app/dashboard/custody/wallet-balances.data";
import { TokenMark } from "@/components/token-mark";
import {
  formatCurrencyAmount,
  formatDisplayAmount,
  resolveTotalBalance,
  shortenAddress,
} from "../../payments/payments-overview.utils";

export interface WalletTrackedBalancesResult {
  balances: CustodyWalletTokenBalance[];
  error: string | null;
  /** When the server read these balances. */
  readAt: number;
}

/** Issued tokens the balance rows link to, keyed by mint. */
export type WalletBalanceTokenRoutes = Record<string, { id: string; name: string | null }>;

/**
 * Starts from the server-rendered balances and polls the same per-wallet endpoint
 * as the overview cards, so funds that land while the page is open — a faucet
 * airdrop, an incoming transfer — appear without a reload. Revalidating
 * `custodyQueryKeys.walletBalances` refreshes it on demand.
 */
function useWalletDetailBalances(
  walletId: string,
  initial: WalletTrackedBalancesResult
): WalletTrackedBalancesResult {
  // A per-read key rather than seeding the cache in an effect (as the issuance list
  // does): effects run after paint, so a return visit would still flash the old balance.
  const { data } = useSWR(
    custodyQueryKeys.walletBalances({ walletId, readAt: initial.readAt }),
    () => fetchWalletBalance(walletId),
    {
      fallbackData: initial.error ? undefined : initial.balances,
      // The key is new per server read, so there is no older cache to replace;
      // only retry at once if that read failed.
      revalidateOnMount: Boolean(initial.error),
      revalidateOnFocus: true,
      refreshWhenHidden: false,
      refreshInterval: BALANCE_REFRESH_INTERVAL_MS,
      dedupingInterval: 5_000,
      // No keepPreviousData: on a new server read (e.g. after a faucet airdrop) it
      // would keep the previous key's balance instead of the fresh fallback.
    }
  );
  // A successful refresh supersedes a failed server read.
  return data ? { ...initial, balances: data, error: null } : initial;
}

export function WalletBalanceTotal({
  walletId,
  initial,
}: {
  walletId: string;
  initial: WalletTrackedBalancesResult;
}) {
  const { balances, error } = useWalletDetailBalances(walletId, initial);

  if (error) {
    return (
      <div className="mt-3 space-y-2">
        <p className="text-[38px] leading-none font-medium tracking-[-0.05em] text-primary">—</p>
        <p className="text-sm text-tertiary">{error}</p>
      </div>
    );
  }

  return (
    <p className="mt-3 text-[38px] leading-none font-medium tracking-[-0.05em] text-primary">
      {formatCurrencyAmount(resolveTotalBalance(balances))}
    </p>
  );
}

export function WalletBalanceRows({
  walletId,
  initial,
  tokenRoutes,
  issuanceEnabled,
  emptyLabel,
}: {
  walletId: string;
  initial: WalletTrackedBalancesResult;
  tokenRoutes: WalletBalanceTokenRoutes;
  issuanceEnabled: boolean;
  emptyLabel: string;
}) {
  const { balances, error } = useWalletDetailBalances(walletId, initial);

  return (
    <>
      {error ? <p className="text-sm text-tertiary">{error}</p> : null}

      {balances.length > 0 ? (
        <div className="overflow-hidden rounded-2xl border border-border-default bg-surface-raised">
          {balances.map((balance) => {
            const ownedToken = balance.token === "SOL" ? null : (tokenRoutes[balance.mint] ?? null);

            return (
              <WalletBalanceRow
                key={`${balance.mint}-${balance.token}`}
                label={ownedToken?.name ?? balance.token}
                value={formatDisplayAmount(balance.uiAmount, balance.token)}
                mint={balance.mint}
                href={issuanceEnabled && ownedToken ? `/dashboard/issuance/${ownedToken.id}` : null}
              />
            );
          })}
        </div>
      ) : (
        <div className="rounded-2xl border border-border-default bg-surface-raised px-4 py-4 text-sm text-secondary">
          {emptyLabel}
        </div>
      )}
    </>
  );
}

function WalletBalanceRow({
  label,
  value,
  mint,
  href = null,
}: {
  label: string;
  value: string;
  mint: string;
  href?: string | null;
}) {
  const content = (
    <div
      className={[
        "flex flex-wrap items-center justify-between gap-4 border-b border-border-subtle px-4 py-3 last:border-b-0",
        href ? "transition-colors hover:bg-fill-subtle" : "",
      ].join(" ")}
    >
      <div className="flex min-w-0 items-center gap-3">
        <TokenMark mint={mint} symbol={label} size="md" />
        <div className="min-w-0">
          <p className="text-[17px] font-medium text-primary">{label}</p>
          {/* The full mint is 44 characters; keep it reachable on hover rather
              than letting it dominate the row. */}
          <p className="font-mono text-xs text-tertiary" title={mint}>
            {shortenAddress(mint)}
          </p>
        </div>
      </div>
      <p className="text-[15px] text-primary tabular-nums">{value}</p>
    </div>
  );

  if (!href) {
    return content;
  }

  return (
    <Link href={href} className="block focus-visible:outline-none">
      {content}
    </Link>
  );
}
