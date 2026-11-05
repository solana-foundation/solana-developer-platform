"use client";

import type { CustodyWalletTokenBalance } from "@sdp/types/custody";
import { resolveTotalBalance } from "./payments/payments-overview.utils";
import {
  type IssuedTokenSymbol,
  useIssuedTokens,
  useWalletAggregate,
  useWalletSummaries,
} from "./payments/shared-reads";

interface HomeRead<T> {
  data: T | undefined;
  error: unknown;
}

export type HomeAccountState =
  | { status: "loading" }
  | { status: "unavailable" }
  | {
      status: "ready";
      walletCount: number;
      balances: CustodyWalletTokenBalance[];
      totalBalance: number | null;
      issuedTokens: IssuedTokenSymbol[];
    };

function readyAccount(
  walletCount: number,
  balances: CustodyWalletTokenBalance[],
  issuedTokens: IssuedTokenSymbol[]
): HomeAccountState {
  return {
    status: "ready",
    walletCount,
    balances,
    totalBalance: resolveTotalBalance(balances),
    issuedTokens,
  };
}

/**
 * The aggregate answers for an organization with wallets. The wallet list only explains a failed
 * aggregate: an organization with no wallet yet is a first run, any other failure is unavailable.
 */
export function resolveHomeAccount(reads: {
  aggregate: HomeRead<{ walletCount: number; balances: CustodyWalletTokenBalance[] }>;
  wallets: HomeRead<readonly unknown[]>;
  issuedTokens: HomeRead<IssuedTokenSymbol[]>;
}): HomeAccountState {
  const { aggregate, wallets, issuedTokens } = reads;
  if (issuedTokens.data === undefined) {
    return issuedTokens.error ? { status: "unavailable" } : { status: "loading" };
  }
  if (aggregate.data !== undefined) {
    return readyAccount(aggregate.data.walletCount, aggregate.data.balances, issuedTokens.data);
  }
  if (!aggregate.error) {
    return { status: "loading" };
  }
  if (wallets.data !== undefined) {
    return wallets.data.length === 0
      ? readyAccount(0, [], issuedTokens.data)
      : { status: "unavailable" };
  }
  return wallets.error ? { status: "unavailable" } : { status: "loading" };
}

const NO_ISSUED_TOKENS: IssuedTokenSymbol[] = [];

export type HomeAccount =
  | Exclude<HomeAccountState, { status: "unavailable" }>
  | { status: "unavailable"; retry: () => void };

/** The reads the balance column and the activity labels share. Pass the Issuance flag. */
export function useHomeAccount(issuanceEnabled: boolean): HomeAccount {
  const aggregate = useWalletAggregate();
  const wallets = useWalletSummaries({ includeBalances: false });
  const issuedTokens = useIssuedTokens(issuanceEnabled);
  const account = resolveHomeAccount({
    aggregate,
    wallets,
    // A deployment without Issuance has issued nothing; the listing is never read.
    issuedTokens: issuanceEnabled ? issuedTokens : { data: NO_ISSUED_TOKENS, error: undefined },
  });
  if (account.status !== "unavailable") {
    return account;
  }
  return {
    status: "unavailable",
    retry: () => {
      for (const read of [aggregate, wallets, issuedTokens]) {
        if (read.error) void read.mutate();
      }
    },
  };
}
