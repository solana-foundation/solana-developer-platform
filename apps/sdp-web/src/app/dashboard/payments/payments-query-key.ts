import type { RampFiatCurrency } from "@sdp/types/generated/ramp";
import type { CryptoRailId } from "@sdp/types/payment-rails";
import type { RampProviderId } from "@sdp/types/provider-access";
import type { RampDirection } from "@sdp/types/ramp-requirements";

export const paymentsQueryKeys = {
  actionCounterparties: () => "payments-action-counterparties",
  actionWallets: () => "payments-action-wallets",
  createTransfer: () => "payments-create-transfer",
  onrampTransferStatus: ({ transferId }: { transferId: string }) =>
    ["onramp-transfer-status", transferId] as const,
  offrampTransferStatus: ({ transferId }: { transferId: string }) =>
    ["offramp-transfer-status", transferId] as const,
  requirementsStatusPoll: ({ subjectKey }: { subjectKey: string }) =>
    ["counterparty-requirements-status-poll", subjectKey] as const,
  counterpartyRequirements: ({
    counterpartyId,
    provider,
    direction,
    cryptoToken,
    fiatCurrency,
    destinationWallet,
    destinationCountry,
  }: {
    counterpartyId: string;
    provider: RampProviderId;
    direction: RampDirection;
    cryptoToken: string;
    fiatCurrency: RampFiatCurrency;
    destinationWallet: string;
    destinationCountry: string;
  }) =>
    [
      "counterparty-requirements",
      counterpartyId,
      provider,
      direction,
      cryptoToken,
      fiatCurrency,
      destinationWallet,
      destinationCountry,
    ] as const,
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
  counterpartyProviderAccounts: ({ counterpartyId }: { counterpartyId: string }) =>
    ["counterparty-provider-accounts", counterpartyId] as const,
  counterpartyRecentTransfers: ({ counterpartyId }: { counterpartyId: string }) =>
    ["counterparty-recent-transfers", counterpartyId] as const,
  batchRecipients: ({ page, search }: { page: number; search: string }) =>
    ["batch-recipients", page, search] as const,
  batchEstimate: ({ serializedRequest }: { serializedRequest: string }) =>
    ["batch-estimate", serializedRequest] as const,
  paymentRequestCounterpartyAccounts: ({ counterpartyId }: { counterpartyId: string }) =>
    ["payment-request-counterparty-accounts", counterpartyId] as const,
  transactionFilterOptions: ({ projectId }: { projectId: string }) =>
    ["payments-transaction-filter-options", projectId] as const,
  counterpartyFieldOptions: () => "counterparty-field-options",
};
