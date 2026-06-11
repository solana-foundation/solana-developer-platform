import type { PaymentsDashboardWallet } from "@sdp/types";
import {
  formatCurrencyAmount,
  resolveTotalBalance,
} from "@/app/dashboard/payments/payments-overview.utils";
import type { ComboboxOption } from "@/components/ui/combobox";

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
