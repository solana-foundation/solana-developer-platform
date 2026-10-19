import type { Country, CountryCode } from "./countries";
import type { PersistedRampProviderId } from "./provider-access";

export const COUNTERPARTY_ENTITY_TYPES = ["individual", "business"] as const;
export type CounterpartyEntityType = (typeof COUNTERPARTY_ENTITY_TYPES)[number];

export type CounterpartyStatus = "active" | "archived";

export type CounterpartyProviderData = Record<string, unknown>;

export type Counterparty = {
  id: string;
  organizationId: string;
  projectId: string | null;
  externalId: string | null;
  entityType: CounterpartyEntityType;
  displayName: string;
  status: CounterpartyStatus;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CreateCounterpartyRequest = {
  externalId?: string;
  entityType: CounterpartyEntityType;
  displayName: string;
};

export interface UpdateCounterpartyRequest {
  externalId?: string | null;
  entityType?: CounterpartyEntityType;
  displayName?: string;
}

export interface CounterpartyResponse {
  counterparty: Counterparty;
}

export interface CounterpartyFieldOptions {
  entityTypes: readonly CounterpartyEntityType[];
  countries: readonly Country[];
}

export interface CounterpartyFieldOptionsResponse {
  fields: CounterpartyFieldOptions;
}

export interface ListCounterpartiesResponse {
  counterparties: Counterparty[];
  total: number;
  page: number;
  pageSize: number;
}

export const COUNTERPARTY_ACCOUNT_KINDS = ["crypto_wallet"] as const;
export type CounterpartyAccountKind = (typeof COUNTERPARTY_ACCOUNT_KINDS)[number];

export type CounterpartyAccountStatus = "active" | "archived";

export type CryptoWalletCounterpartyAccountDetails = Record<string, unknown> & {
  address: string;
};

export type CounterpartyAccountDetails = Record<string, unknown>;

export type CounterpartyAccountProviderData = Record<string, unknown>;

export interface CounterpartyAccount {
  id: string;
  organizationId: string;
  projectId: string;
  counterpartyId: string;
  accountKind: CounterpartyAccountKind;
  label: string | null;
  details: CryptoWalletCounterpartyAccountDetails;
  providerAccountData: CounterpartyAccountProviderData;
  status: CounterpartyAccountStatus;
  createdAt: string;
  updatedAt: string;
}

export interface CreateCounterpartyAccountRequest {
  accountKind: CounterpartyAccountKind;
  label?: string;
  details?: CounterpartyAccountDetails;
  providerAccountData?: CounterpartyAccountProviderData;
}

export interface UpdateCounterpartyAccountRequest {
  label?: string | null;
  details?: CounterpartyAccountDetails;
  providerAccountData?: CounterpartyAccountProviderData;
}

export interface CounterpartyAccountResponse {
  account: CounterpartyAccount;
}

export interface ListCounterpartyAccountsResponse {
  accounts: CounterpartyAccount[];
  total: number;
  page: number;
  pageSize: number;
}

/** Availability of a provider wallet's live balance; `unavailable` keeps the row visible when the provider read fails. */
export const PROVIDER_WALLET_BALANCE_STATES = ["available", "unavailable"] as const;
export type ProviderWalletBalanceState = (typeof PROVIDER_WALLET_BALANCE_STATES)[number];

/**
 * Live provider-wallet balance, fetched just in time and never persisted
 * or cached. `amount` is a decimal string in the wallet's `currency`.
 */
export type ProviderWalletBalance =
  | { state: "available"; amount: string; currency: string }
  | { state: "unavailable" };

export interface CounterpartyProviderAccount {
  id: string;
  /** A retired provider's accounts still read, as stored. */
  provider: PersistedRampProviderId;
  kind: CounterpartyProviderAccountKind;
  fiatCurrency: string | null;
  destinationCountry: CountryCode | null;
  paymentRail: string | null;
  status: CounterpartyAccountStatus;
  providerStatus: string | null;
  createdAt: string;
  customerLink?: CounterpartyProviderCustomerLink;
  /** The provider's own wallet/account id; present on wallet kinds whose provider reference exists. */
  providerAccountReference?: string;
  /** Live balance, present only on wallet kinds whose reference exists. */
  balance?: ProviderWalletBalance;
}

interface CounterpartyProviderCustomerLinkBase {
  id: string;
  status: CounterpartyAccountStatus;
  providerStatus: string | null;
  createdAt: string;
}

export interface CounterpartyProviderCustomerLink extends CounterpartyProviderCustomerLinkBase {
  provider: PersistedRampProviderId;
  providerCustomerReference: string;
}

export type CounterpartyProviderAccountKind =
  | "customer_link"
  | "payout_account"
  | "funding_wallet"
  | "merchant_wallet";

/** Row kinds the counterparty provider-accounts list endpoint returns. */
export const COUNTERPARTY_PROVIDER_ACCOUNT_LISTED_KINDS = [
  "payout_account",
  "customer_link",
  "funding_wallet",
] as const satisfies readonly CounterpartyProviderAccountKind[];

export interface ListCounterpartyProviderAccountsResponse {
  accounts: CounterpartyProviderAccount[];
}
