import type { CryptoRailId } from "@sdp/types/payment-rails";
import type { RampDirection } from "@sdp/types/ramp-requirements";

/**
 * SWR key factory for the payments dashboard. Every payments cache key is
 * declared here once so shared keys cannot drift apart across call sites and
 * key parameters stay typed.
 */
export const paymentsQueryKeys = {
  actionCounterparties: () => "payments-action-counterparties",
  actionWallets: () => "payments-action-wallets",
  onrampTransferStatus: ({ transferId }: { transferId: string }) =>
    ["onramp-transfer-status", transferId] as const,
  offrampTransferStatus: ({ transferId }: { transferId: string }) =>
    ["offramp-transfer-status", transferId] as const,
  readyQuote: ({ direction }: { direction: RampDirection | "ramp" }) =>
    ["ready-quote", direction] as const,
  requirementsStatusPoll: ({ subjectKey }: { subjectKey: string }) =>
    ["counterparty-requirements-status-poll", subjectKey] as const,
  rampEstimate: ({
    direction,
    fiatCurrency,
    assetRail,
    amount,
  }: {
    direction: RampDirection;
    fiatCurrency: string;
    assetRail: CryptoRailId;
    amount: string;
  }) => ["ramp-estimate", direction, fiatCurrency, assetRail, amount] as const,
  counterpartyAccounts: ({ counterpartyId }: { counterpartyId: string }) =>
    ["counterparty-accounts", counterpartyId] as const,
  counterpartyRecentTransfers: ({ counterpartyId }: { counterpartyId: string }) =>
    ["counterparty-recent-transfers", counterpartyId] as const,
  batchRecipients: ({ page, search }: { page: number; search: string }) =>
    ["batch-recipients", page, search] as const,
  batchEstimate: ({ serializedRequest }: { serializedRequest: string }) =>
    ["batch-estimate", serializedRequest] as const,
  paymentRequestCounterpartyAccounts: ({ counterpartyId }: { counterpartyId: string }) =>
    ["payment-request-counterparty-accounts", counterpartyId] as const,
  transactionFilterOptions: ({ projectId }: { projectId: string }) =>
    ["payments-transaction-filter-options-v2", projectId] as const,
  counterpartyFieldOptions: () => "counterparty-field-options",
};
