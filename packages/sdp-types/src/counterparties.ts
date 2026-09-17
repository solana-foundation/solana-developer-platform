import type { Country, CountryCode } from "./countries";
import type { RampProviderId } from "./provider-access";

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

export interface CounterpartyProviderAccount {
  id: string;
  provider: RampProviderId;
  kind: CounterpartyProviderAccountKind;
  fiatCurrency: string | null;
  destinationCountry: CountryCode | null;
  paymentRail: string | null;
  status: CounterpartyAccountStatus;
  providerStatus: string | null;
  createdAt: string;
  bankName?: string;
  accountNumberLast4?: string;
  paymentRails?: string[];
  customerLink?: CounterpartyProviderCustomerLink;
}

/**
 * Public provider-side identity link carried on provider-account rows. The
 * reference is the provider's counterparty object id (a BVNK contact id, a
 * Lightspark Grid customer id, or the equivalent identity object).
 */
export interface CounterpartyProviderCustomerLink {
  provider: RampProviderId;
  id: string;
  providerCustomerReference: string;
  status: CounterpartyAccountStatus;
  providerStatus: string | null;
  createdAt: string;
}

export type CounterpartyProviderAccountKind =
  | "customer_link"
  | "payout_account"
  | "funding_wallet"
  | "merchant_wallet";

export interface ListCounterpartyProviderAccountsResponse {
  accounts: CounterpartyProviderAccount[];
}
