import type {
  CounterpartyProviderAccount,
  CounterpartyProviderCustomerLink,
  RampProviderId,
} from "@sdp/types";

export type FundingWalletAccount = CounterpartyProviderAccount & { fiatCurrency: string };

export interface ProviderCustomerGroup {
  provider: RampProviderId;
  customerLink: CounterpartyProviderCustomerLink | undefined;
  payoutAccounts: CounterpartyProviderAccount[];
  fundingWallets: FundingWalletAccount[];
}

function toFundingWalletAccount(account: CounterpartyProviderAccount): FundingWalletAccount {
  if (account.fiatCurrency === null) {
    throw new Error(`Funding wallet ${account.id} has no fiat currency`);
  }
  return { ...account, fiatCurrency: account.fiatCurrency };
}

/**
 * Groups provider-account rows by provider with the customer link lifted onto the group.
 *
 * @param accounts - Flat provider-account rows from the API.
 * @returns One group per provider in first-seen order.
 */
export function groupProviderAccounts(
  accounts: CounterpartyProviderAccount[]
): ProviderCustomerGroup[] {
  const groups = new Map<RampProviderId, ProviderCustomerGroup>();
  for (const account of accounts) {
    let group = groups.get(account.provider);
    if (group === undefined) {
      group = {
        provider: account.provider,
        customerLink: undefined,
        payoutAccounts: [],
        fundingWallets: [],
      };
      groups.set(account.provider, group);
    }
    if (account.kind === "payout_account") {
      group.payoutAccounts.push(account);
    }
    if (account.kind === "funding_wallet") {
      group.fundingWallets.push(toFundingWalletAccount(account));
    }
    if (account.customerLink !== undefined) {
      group.customerLink = account.customerLink;
    }
  }
  return [...groups.values()];
}
