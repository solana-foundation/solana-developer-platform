import type { UnifiedTransactionModule } from "@sdp/types";
import { transactionHref } from "@/lib/payments-routes";

export const TRANSACTION_MODULE_HREFS = {
  payments: transactionHref,
  earn: (id) => `/dashboard/markets/earn?transaction=${encodeURIComponent(id)}`,
  dvp: (id) => `/dashboard/markets/dvp/${encodeURIComponent(id)}`,
  private_channels: (id) =>
    `/dashboard/integrations/private-channels?transaction=${encodeURIComponent(id)}`,
  issuance: (id) => `/dashboard/issuance?transaction=${encodeURIComponent(id)}`,
  rings: (id) => `/dashboard/helius-rings?operation=${encodeURIComponent(id)}`,
} as const satisfies Record<UnifiedTransactionModule, (id: string) => string>;

/** Dashboard detail route for a custody wallet. */
export function walletHref(custodyWalletId: string): string {
  return `/dashboard/wallets/${encodeURIComponent(custodyWalletId)}`;
}

/** Dashboard detail route for a counterparty. */
export function counterpartyHref(counterpartyId: string): string {
  return `/dashboard/payments/counterparty/${encodeURIComponent(counterpartyId)}`;
}
