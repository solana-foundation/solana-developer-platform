import type { PaymentsDashboardWallet } from "@sdp/types";
import {
  formatCurrencyAmount,
  isSolBalance,
  resolveAggregateBalanceDisplayToken,
  resolveTotalBalance,
} from "@/app/dashboard/payments/payments-overview.utils";
import type { ComboboxOption } from "@/components/ui/combobox";

type WalletBalance = NonNullable<PaymentsDashboardWallet["balances"]>[number];
type IssuedTokenSymbolsByMint = Record<string, string>;

interface ResolveWalletAssetOptionsConfig {
  includeDefaultUsdc?: boolean;
  hideUnresolvedMints?: boolean;
}

const DISPLAYABLE_TOKEN_SYMBOL_PATTERN = /^[A-Z0-9][A-Z0-9._-]{0,11}$/;

function isDisplayableTokenSymbol(value: string): boolean {
  return DISPLAYABLE_TOKEN_SYMBOL_PATTERN.test(value.trim().toUpperCase());
}

export function resolveWalletAssetOptions(
  wallet: PaymentsDashboardWallet | null,
  issuedTokenSymbolsByMint: IssuedTokenSymbolsByMint,
  options: ResolveWalletAssetOptionsConfig = {}
): string[] {
  const assetSet = new Set<string>(options.includeDefaultUsdc === false ? [] : ["USDC"]);
  for (const balance of wallet?.balances ?? []) {
    if (isSolBalance(balance)) {
      continue;
    }

    const token = resolveAggregateBalanceDisplayToken(balance, issuedTokenSymbolsByMint);
    if (options.hideUnresolvedMints && !isDisplayableTokenSymbol(token)) {
      continue;
    }
    if (token) {
      assetSet.add(token);
    }
  }
  return [...assetSet];
}

export function findWalletBalanceForToken(
  wallet: PaymentsDashboardWallet | null,
  token: string
): WalletBalance | null {
  return wallet?.balances?.find((balance) => balance.token === token) ?? null;
}

export function findWalletBalanceForDisplayToken(
  wallet: PaymentsDashboardWallet | null,
  token: string,
  issuedTokenSymbolsByMint: IssuedTokenSymbolsByMint
): WalletBalance | null {
  const normalizedToken = token.trim().toUpperCase();
  if (!normalizedToken) {
    return null;
  }

  return (
    wallet?.balances?.find((balance) => {
      const displayToken = resolveAggregateBalanceDisplayToken(balance, issuedTokenSymbolsByMint);
      return (
        displayToken.trim().toUpperCase() === normalizedToken ||
        balance.token.trim().toUpperCase() === normalizedToken ||
        balance.mint.trim() === token.trim()
      );
    }) ?? null
  );
}

export function walletComboboxOptions(wallets: PaymentsDashboardWallet[]): ComboboxOption[] {
  return wallets.map((wallet) => {
    const total = resolveTotalBalance(wallet.balances ?? []);
    return {
      value: wallet.walletId,
      label: wallet.label ?? wallet.walletId,
      description: total !== null ? formatCurrencyAmount(total) : undefined,
    };
  });
}
