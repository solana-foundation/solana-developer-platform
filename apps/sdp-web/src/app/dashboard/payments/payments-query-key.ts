import type { RampFiatCurrency } from "@sdp/types/generated/ramp";
import type { CryptoRailId } from "@sdp/types/payment-rails";
import type { RampProviderId } from "@sdp/types/provider-access";
import type { RampDirection } from "@sdp/types/ramp-requirements";

export interface CounterpartyRequirementsParams {
  counterpartyId: string;
  provider: RampProviderId | null;
  direction: RampDirection;
  assetRail: CryptoRailId;
  fiatCurrency: RampFiatCurrency;
  /** Onramp only: the destination custody wallet the quote pays into. null until selected. */
  destinationCustodyWalletId: string | null;
}

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
  isCounterpartyRequirementsKey: (key: unknown) =>
    Array.isArray(key) && key[0] === "counterparty-requirements",
  counterpartyRequirements: ({
    counterpartyId,
    provider,
    direction,
    assetRail,
    fiatCurrency,
    destinationCustodyWalletId,
  }: {
    counterpartyId: string;
    provider: RampProviderId;
    direction: RampDirection;
    assetRail: CryptoRailId;
    fiatCurrency: RampFiatCurrency;
    destinationCustodyWalletId: string;
  }) =>
    [
      "counterparty-requirements",
      counterpartyId,
      provider,
      direction,
      assetRail,
      fiatCurrency,
      destinationCustodyWalletId,
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

/**
 * Builds the SWR key for the counterparty-requirements fetch. Returns null (no
 * fetch) until a provider, counterparty, and — for onramp — a destination
 * custody wallet are all chosen, so the fetcher never sees an absent wallet id.
 * For offramp the wallet id is irrelevant and the key carries an empty string
 * sentinel.
 *
 * @param params - The requirements params, or null while the caller is disabled.
 * @returns The SWR key, or null while a required selection is missing.
 */
export function buildCounterpartyRequirementsKey(
  params: CounterpartyRequirementsParams | null
): ReturnType<typeof paymentsQueryKeys.counterpartyRequirements> | null {
  if (params === null || params.provider === null || params.counterpartyId === "") {
    return null;
  }
  const destinationCustodyWalletId =
    params.direction === "offramp" ? "" : params.destinationCustodyWalletId;
  if (destinationCustodyWalletId === null) {
    return null;
  }
  return paymentsQueryKeys.counterpartyRequirements({
    counterpartyId: params.counterpartyId,
    provider: params.provider,
    direction: params.direction,
    assetRail: params.assetRail,
    fiatCurrency: params.fiatCurrency,
    destinationCustodyWalletId,
  });
}
