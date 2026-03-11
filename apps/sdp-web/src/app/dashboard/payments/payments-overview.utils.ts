import type {
  CustodyWalletAggregate,
  CustodyWalletTokenBalance,
  PaymentTransferSummary as TransferRecord,
  PaymentsDashboardWallet as WalletRecord,
} from "@sdp/types";

const REQUIRED_AGGREGATE_BALANCE_ROWS = [
  { token: "SOL", mint: "sol" },
  { token: "USDC", mint: "usdc" },
] as const;

export function formatDisplayAmount(value?: string, token?: string): string {
  if (!value) {
    return token ? `- ${token}` : "-";
  }

  const numericValue = Number(value);
  const formattedValue = Number.isFinite(numericValue)
    ? new Intl.NumberFormat("en-US", {
        minimumFractionDigits: numericValue >= 100 ? 0 : 2,
        maximumFractionDigits: 6,
      }).format(numericValue)
    : value;

  return token ? `${formattedValue} ${token}` : formattedValue;
}

export function formatCurrencyAmount(value: number | string | null): string {
  if (value === null) {
    return "$0.00";
  }

  const numericValue = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numericValue)) {
    return "$0.00";
  }

  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(numericValue);
}

export function formatTimestamp(value?: string): string {
  if (!value) {
    return "Pending";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "Pending";
  }

  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

export function formatDirection(direction?: string): string {
  if (!direction) {
    return "Unknown";
  }
  return direction[0]?.toUpperCase() + direction.slice(1);
}

export function resolveCounterparty(transfer: TransferRecord): string {
  if (transfer.direction === "outbound") {
    return transfer.destination ?? "Unavailable";
  }

  if (transfer.direction === "inbound") {
    return transfer.source ?? "Unavailable";
  }

  return transfer.destination ?? transfer.source ?? "Unavailable";
}

export function resolveTotalBalance(balances: CustodyWalletTokenBalance[]): number | null {
  if (balances.length === 0) {
    return null;
  }

  let hasNumericBalance = false;
  const total = balances.reduce((sum, balance) => {
    const numericValue = Number(balance.uiAmount);
    if (!Number.isFinite(numericValue)) {
      return sum;
    }

    hasNumericBalance = true;
    return sum + numericValue;
  }, 0);

  return hasNumericBalance ? total : null;
}

export function aggregateBalancesFromWallets(wallets: WalletRecord[]): CustodyWalletTokenBalance[] {
  const aggregate = new Map<
    string,
    { token: string; mint: string; amount: number; decimals: number }
  >();

  for (const wallet of wallets) {
    for (const balance of wallet.balances ?? []) {
      const current = aggregate.get(balance.mint);
      const numericValue = Number(balance.uiAmount);
      if (!Number.isFinite(numericValue)) {
        continue;
      }

      if (!current) {
        aggregate.set(balance.mint, {
          token: balance.token,
          mint: balance.mint,
          amount: numericValue,
          decimals: balance.decimals,
        });
        continue;
      }

      current.amount += numericValue;
    }
  }

  return [...aggregate.values()].map((entry) => ({
    token: entry.token,
    mint: entry.mint,
    amount: "0",
    uiAmount: entry.amount.toString(),
    decimals: entry.decimals,
  }));
}

export function normalizeAggregateBalances(
  balances: CustodyWalletTokenBalance[]
): CustodyWalletTokenBalance[] {
  const balancesByToken = new Map(
    balances.map((balance) => [balance.token.toUpperCase(), balance] as const)
  );

  const requiredBalances = REQUIRED_AGGREGATE_BALANCE_ROWS.map(({ token, mint }) => {
    const existingBalance = balancesByToken.get(token);
    if (existingBalance) {
      return existingBalance;
    }

    return {
      token,
      mint,
      amount: "0",
      uiAmount: "0",
      decimals: token === "SOL" ? 9 : 6,
    };
  });

  const remainingBalances = balances.filter(
    (balance) => !REQUIRED_AGGREGATE_BALANCE_ROWS.some(({ token }) => token === balance.token)
  );

  return [...requiredBalances, ...remainingBalances];
}

export function resolveAggregateBalanceRows(
  aggregate: CustodyWalletAggregate | null,
  wallets: WalletRecord[]
): CustodyWalletTokenBalance[] {
  if (aggregate?.balances) {
    return normalizeAggregateBalances(aggregate.balances);
  }

  return normalizeAggregateBalances(aggregateBalancesFromWallets(wallets));
}
