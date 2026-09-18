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

/** SDP-owned lifecycle of a BVNK customer link before BVNK's own customer status exists. */
export const BVNK_CUSTOMER_LINK_STAGE_STATUSES = ["PENDING_AGREEMENT", "AGREEMENT_SIGNED"] as const;
export type BvnkCustomerLinkStageStatus = (typeof BVNK_CUSTOMER_LINK_STAGE_STATUSES)[number];
/** Named access to the BVNK customer-link stage statuses for the read model that derives them. */
export const BVNK_CUSTOMER_LINK_STAGE = {
  pendingAgreement: "PENDING_AGREEMENT",
  agreementSigned: "AGREEMENT_SIGNED",
} as const satisfies Record<string, BvnkCustomerLinkStageStatus>;

/** SDP-owned lifecycle of a BVNK customer funding wallet, written to the row's `provider_status`. */
export const BVNK_FUNDING_WALLET_STATUSES = [
  "provisioning_funding_wallet",
  "provisioned_funding_wallet",
  "funding_wallet_locked",
] as const;
export type BvnkFundingWalletStatus = (typeof BVNK_FUNDING_WALLET_STATUSES)[number];
export const BVNK_FUNDING_WALLET_STATUS = {
  provisioning: "provisioning_funding_wallet",
  provisioned: "provisioned_funding_wallet",
  locked: "funding_wallet_locked",
} as const satisfies Record<string, BvnkFundingWalletStatus>;

export interface CounterpartyProviderCustomerLinkAgreement {
  name: string;
  displayName: string;
  url: string;
  privacyPolicyUrl: string;
  /** When the counterparty signed the agreement session; null while consent is pending. */
  signedAt: string | null;
}

interface CounterpartyProviderCustomerLinkBase {
  id: string;
  status: CounterpartyAccountStatus;
  providerStatus: string | null;
  createdAt: string;
}

/**
 * BVNK customer link. The reference is null until the v1 customer exists;
 * the residence country and agreement session are recorded at mint and kept
 * for the life of the row.
 */
export interface BvnkCounterpartyProviderCustomerLink extends CounterpartyProviderCustomerLinkBase {
  provider: "bvnk";
  providerCustomerReference: string | null;
  residenceCountryCode: CountryCode;
  agreements: CounterpartyProviderCustomerLinkAgreement[];
}

export interface GenericCounterpartyProviderCustomerLink
  extends CounterpartyProviderCustomerLinkBase {
  provider: Exclude<RampProviderId, "bvnk">;
  providerCustomerReference: string;
}

export type CounterpartyProviderCustomerLink =
  | BvnkCounterpartyProviderCustomerLink
  | GenericCounterpartyProviderCustomerLink;

export type CounterpartyProviderAccountKind =
  | "customer_link"
  | "payout_account"
  | "funding_wallet"
  | "merchant_wallet";

export interface ListCounterpartyProviderAccountsResponse {
  accounts: CounterpartyProviderAccount[];
}
