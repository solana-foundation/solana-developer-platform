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

function shouldHideUnresolvedMintLabel(
  balance: Pick<WalletBalance, "token" | "mint">,
  displayToken: string,
  issuedTokenSymbolsByMint: IssuedTokenSymbolsByMint
): boolean {
  const mint = balance.mint.trim();
  if (issuedTokenSymbolsByMint[mint]?.trim()) {
    return false;
  }
  return displayToken.trim().toUpperCase() === mint.toUpperCase();
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
    if (
      options.hideUnresolvedMints &&
      shouldHideUnresolvedMintLabel(balance, token, issuedTokenSymbolsByMint)
    ) {
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

export function walletBalanceAssetOptions(
  wallet: PaymentsDashboardWallet | null,
  issuedTokenSymbolsByMint: IssuedTokenSymbolsByMint,
  options: Pick<ResolveWalletAssetOptionsConfig, "hideUnresolvedMints"> = {}
): ComboboxOption[] {
  const seen = new Set<string>();
  const assetOptions: ComboboxOption[] = [];

  for (const balance of wallet?.balances ?? []) {
    if (isSolBalance(balance)) {
      continue;
    }

    const mint = balance.mint.trim();
    const label = resolveAggregateBalanceDisplayToken(balance, issuedTokenSymbolsByMint);
    if (
      !mint ||
      seen.has(mint) ||
      (options.hideUnresolvedMints &&
        shouldHideUnresolvedMintLabel(balance, label, issuedTokenSymbolsByMint))
    ) {
      continue;
    }

    seen.add(mint);
    assetOptions.push({
      value: mint,
      label,
      description: `${balance.uiAmount} available`,
    });
  }

  return assetOptions;
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
