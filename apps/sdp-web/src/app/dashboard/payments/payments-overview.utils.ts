import type {
  CustodyWalletAggregate,
  CustodyWalletTokenBalance,
  PaymentTransferSummary as TransferRecord,
  PaymentsDashboardWallet as WalletRecord,
} from "@sdp/types";
import { CRYPTO_ASSET_DECIMALS, type CryptoAssetSymbol } from "@sdp/types/payment-rails";

// biome-ignore lint/security/noSecrets: Devnet USDC mint address constant, not a secret.
const DEVNET_USDC_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
// biome-ignore lint/security/noSecrets: Mainnet USDC mint address constant, not a secret.
const MAINNET_USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
// biome-ignore lint/security/noSecrets: Solana native mint address constant, not a secret.
const SOL_MINT = "So11111111111111111111111111111111111111112";

function parseIntegerAmount(value: string): bigint | null {
  if (!/^\d+$/.test(value)) {
    return null;
  }

  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

function formatUiAmountFromRaw(amount: bigint, decimals: number): string {
  if (decimals <= 0) {
    return amount.toString();
  }

  const scale = BigInt(10) ** BigInt(decimals);
  const whole = amount / scale;
  const fraction = (amount % scale).toString().padStart(decimals, "0").replace(/0+$/, "");

  return fraction ? `${whole}.${fraction}` : whole.toString();
}

function resolveFallbackUsdValue(
  balance: Pick<CustodyWalletTokenBalance, "token" | "mint" | "uiAmount">
) {
  const normalizedToken = balance.token.trim().toUpperCase();
  if (
    normalizedToken !== "USDC" &&
    balance.mint !== DEVNET_USDC_MINT &&
    balance.mint !== MAINNET_USDC_MINT
  ) {
    return null;
  }

  const uiAmount = Number(balance.uiAmount);
  return Number.isFinite(uiAmount) ? uiAmount : null;
}

export function resolveUsdBalanceValue(
  balance: Pick<CustodyWalletTokenBalance, "token" | "mint" | "uiAmount" | "usdValue">
): number | null {
  if (typeof balance.usdValue === "number" && Number.isFinite(balance.usdValue)) {
    return balance.usdValue;
  }

  return resolveFallbackUsdValue(balance);
}

export function isSolBalance(balance: Pick<CustodyWalletTokenBalance, "token" | "mint">): boolean {
  return balance.token.trim().toUpperCase() === "SOL" || balance.mint.trim() === SOL_MINT;
}

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

export function formatMinorCurrencyAmount(
  amount: number | undefined,
  currency: string
): string | null {
  if (amount === undefined || !Number.isFinite(amount)) {
    return null;
  }

  const decimals = CRYPTO_ASSET_DECIMALS[currency as CryptoAssetSymbol] ?? 2;
  const value = amount / 10 ** decimals;
  return `${value.toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: decimals,
  })} ${currency.toUpperCase()}`;
}

export function formatRampQuoteExpiry(expiresAt: string | undefined): string | null {
  if (!expiresAt) {
    return null;
  }

  const date = new Date(expiresAt);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function formatRampQuoteTimeRemaining(
  expiresAt: string | undefined,
  nowMs = Date.now()
): string | null {
  if (!expiresAt) {
    return null;
  }

  const expiresAtMs = new Date(expiresAt).getTime();
  if (Number.isNaN(expiresAtMs)) {
    return null;
  }

  const remainingSeconds = Math.max(0, Math.ceil((expiresAtMs - nowMs) / 1000));
  if (remainingSeconds === 0) {
    return "Expired";
  }

  const minutes = Math.floor(remainingSeconds / 60);
  const seconds = remainingSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
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
    const usdValue = resolveUsdBalanceValue(balance);
    if (usdValue === null) {
      return sum;
    }

    hasNumericBalance = true;
    return sum + usdValue;
  }, 0);

  return hasNumericBalance ? total : null;
}

export function aggregateBalancesFromWallets(wallets: WalletRecord[]): CustodyWalletTokenBalance[] {
  const aggregate = new Map<
    string,
    { token: string; mint: string; amount: bigint; decimals: number; usdValue: number | null }
  >();

  for (const wallet of wallets) {
    for (const balance of wallet.balances ?? []) {
      const current = aggregate.get(balance.mint);
      const numericValue = Number(balance.uiAmount);
      const rawAmount = parseIntegerAmount(balance.amount);
      const usdValue = resolveUsdBalanceValue(balance);
      if (!Number.isFinite(numericValue) || rawAmount === null) {
        continue;
      }

      if (!current) {
        aggregate.set(balance.mint, {
          token: balance.token,
          mint: balance.mint,
          amount: rawAmount,
          decimals: balance.decimals,
          usdValue,
        });
        continue;
      }

      current.amount += rawAmount;
      if (usdValue !== null) {
        current.usdValue = (current.usdValue ?? 0) + usdValue;
      }
    }
  }

  return [...aggregate.values()].map((entry) => ({
    token: entry.token,
    mint: entry.mint,
    amount: entry.amount.toString(),
    uiAmount: formatUiAmountFromRaw(entry.amount, entry.decimals),
    decimals: entry.decimals,
    ...(entry.usdValue !== null ? { usdValue: Number(entry.usdValue.toFixed(6)) } : {}),
  }));
}

export function normalizeAggregateBalances(
  balances: CustodyWalletTokenBalance[]
): CustodyWalletTokenBalance[] {
  return balances
    .filter((balance) => !isSolBalance(balance))
    .filter((balance) => resolveUsdBalanceValue(balance) !== null)
    .sort((left, right) => {
      const leftIsUsdc = left.token.trim().toUpperCase() === "USDC";
      const rightIsUsdc = right.token.trim().toUpperCase() === "USDC";

      if (leftIsUsdc && !rightIsUsdc) {
        return -1;
      }
      if (!leftIsUsdc && rightIsUsdc) {
        return 1;
      }

      return left.token.localeCompare(right.token);
    });
}

export function resolveAggregateBalanceDisplayToken(
  balance: Pick<CustodyWalletTokenBalance, "token" | "mint">,
  issuedTokenSymbolsByMint: Record<string, string>
): string {
  const normalizedMint = balance.mint.trim();
  const issuedTokenSymbol = issuedTokenSymbolsByMint[normalizedMint]?.trim();

  if (issuedTokenSymbol) {
    return issuedTokenSymbol.toUpperCase();
  }

  const normalizedToken = balance.token.trim().toUpperCase();
  if (normalizedToken) {
    return normalizedToken;
  }

  return normalizedMint;
}

export function selectTopAggregateBalanceRows(
  balances: CustodyWalletTokenBalance[],
  issuedTokenSymbolsByMint: Record<string, string>,
  limit = 3
): CustodyWalletTokenBalance[] {
  if (balances.length <= limit) {
    return balances;
  }

  const sorted = [...balances].sort((left, right) => {
    const leftIsUsdc =
      resolveAggregateBalanceDisplayToken(left, issuedTokenSymbolsByMint) === "USDC";
    const rightIsUsdc =
      resolveAggregateBalanceDisplayToken(right, issuedTokenSymbolsByMint) === "USDC";

    if (leftIsUsdc && !rightIsUsdc) {
      return -1;
    }
    if (!leftIsUsdc && rightIsUsdc) {
      return 1;
    }

    const leftUsdValue = resolveUsdBalanceValue(left) ?? 0;
    const rightUsdValue = resolveUsdBalanceValue(right) ?? 0;
    if (leftUsdValue !== rightUsdValue) {
      return rightUsdValue - leftUsdValue;
    }

    return resolveAggregateBalanceDisplayToken(left, issuedTokenSymbolsByMint).localeCompare(
      resolveAggregateBalanceDisplayToken(right, issuedTokenSymbolsByMint)
    );
  });

  return sorted.slice(0, limit);
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
