import { compareDecimalAmounts, isDecimalString } from "@sdp/solana/amount";
import type { PaymentsDashboardWallet } from "@sdp/types/payments";
import type { ComboboxOption } from "@sdp/ui/combobox";
import {
  formatCurrencyAmount,
  resolveAggregateBalanceDisplayToken,
  resolveTotalBalance,
} from "@/app/dashboard/[projectId]/payments/payments-overview.utils";
import type { MessageKey } from "@/i18n/messages";
import type { TranslationValues } from "@/i18n/translate";

type WalletBalance = NonNullable<PaymentsDashboardWallet["balances"]>[number];
type IssuedTokenSymbolsByMint = Record<string, string>;
type Translate = (key: MessageKey, values?: TranslationValues) => string;

interface ResolveWalletAssetOptionsConfig {
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

export function findWalletBalanceForToken(
  wallet: PaymentsDashboardWallet | null,
  token: string
): WalletBalance | null {
  return wallet?.balances?.find((balance) => balance.token === token) ?? null;
}

/**
 * What the wallet holds of `token`: "0" when its balances were read without
 * the token, null with no wallet or when the API could not read them (it then
 * omits `balances`), so an unread balance never passes for an empty one.
 */
export function walletTokenBalance(
  wallet: PaymentsDashboardWallet | null,
  token: string
): string | null {
  if (wallet?.balances === undefined) return null;
  return findWalletBalanceForToken(wallet, token)?.uiAmount ?? "0";
}

/** Whether `amount` of `token` is more than the wallet holds; false until both are known. */
export function exceedsWalletBalance(
  wallet: PaymentsDashboardWallet | null,
  token: string,
  amount: string
): boolean {
  const wanted = amount.trim();
  const held = walletTokenBalance(wallet, token);
  return (
    held !== null &&
    isDecimalString(wanted) &&
    isDecimalString(held) &&
    compareDecimalAmounts(wanted, held) > 0
  );
}

/** What Max fills in: a positive held balance, else null. */
export function maxPayoutAmount(held: string | null): string | null {
  return held !== null && isDecimalString(held) && compareDecimalAmounts(held, "0") > 0
    ? held
    : null;
}

export function walletBalanceAssetOptions(
  wallet: PaymentsDashboardWallet | null,
  issuedTokenSymbolsByMint: IssuedTokenSymbolsByMint,
  t: Translate,
  options: Pick<ResolveWalletAssetOptionsConfig, "hideUnresolvedMints"> = {}
): ComboboxOption[] {
  const seen = new Set<string>();
  const assetOptions: ComboboxOption[] = [];

  for (const balance of wallet?.balances ?? []) {
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
      description: t("DashboardPayments.ramps.balanceAvailable", { amount: balance.uiAmount }),
    });
  }

  return assetOptions;
}

/** How the wallet pickers name a wallet: its label, else its public key. */
export function walletPickerLabel(
  wallet: Pick<PaymentsDashboardWallet, "label" | "publicKey">
): string {
  return wallet.label ?? wallet.publicKey;
}

export function walletComboboxOptions(
  wallets: PaymentsDashboardWallet[],
  signingUnavailableLabel?: string,
  { disableRestricted = false }: { disableRestricted?: boolean } = {}
): ComboboxOption[] {
  return wallets.map((wallet) => {
    const restricted = wallet.isRuntimeExecutionAllowed !== true;
    const total = resolveTotalBalance(wallet.balances ?? []);
    return {
      value: wallet.id,
      label: walletPickerLabel(wallet),
      description: total !== null ? formatCurrencyAmount(total) : undefined,
      ...(signingUnavailableLabel && restricted
        ? { badge: signingUnavailableLabel, badgeVariant: "warning" as const }
        : {}),
      // A signing flow cannot use a restricted wallet, so its picker does not let
      // the user select it; receiving and drafts still can, so they leave it open.
      ...(disableRestricted && restricted ? { disabled: true } : {}),
    };
  });
}
