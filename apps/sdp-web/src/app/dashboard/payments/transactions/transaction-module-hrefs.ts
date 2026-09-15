import type { UnifiedTransactionModule } from "@sdp/types";

export const TRANSACTION_MODULE_HREFS = {
  payments: (id) => `/dashboard/payments/transactions?transaction=${encodeURIComponent(id)}`,
  earn: (id) => `/dashboard/markets/earn?transaction=${encodeURIComponent(id)}`,
  dvp: (id) => `/dashboard/markets/dvp/${encodeURIComponent(id)}`,
  private_channels: (id) =>
    `/dashboard/integrations/private-channels?transaction=${encodeURIComponent(id)}`,
  issuance: (id) => `/dashboard/issuance?transaction=${encodeURIComponent(id)}`,
  rings: (id) => `/dashboard/helius-rings?operation=${encodeURIComponent(id)}`,
} as const satisfies Record<UnifiedTransactionModule, (id: string) => string>;
