import type { Country, CountryCode } from "./countries";

export const COUNTERPARTY_ENTITY_TYPES = ["individual", "business"] as const;
export type CounterpartyEntityType = (typeof COUNTERPARTY_ENTITY_TYPES)[number];

export interface CounterpartyAddress {
  line1: string;
  line2?: string;
  city: string;
  postalCode?: string;
  countryCode: CountryCode;
  subdivisionCode?: string;
}

export const COUNTERPARTY_EMPLOYMENT_STATUSES = [
  "SELF_EMPLOYED",
  "SALARIED",
  "UNEMPLOYED",
  "RETIRED",
  "NOT_PROVIDED",
] as const;

export const COUNTERPARTY_SOURCE_OF_FUNDS = [
  "SALARY",
  "PENSION",
  "SAVINGS",
  "SELF_EMPLOYMENT",
  "CRYPTO_TRADING",
  "GAMBLING",
  "REAL_ESTATE",
] as const;

export const COUNTERPARTY_PEP_STATUSES = [
  "NOT_PEP",
  "FORMER_PEP_2_YEARS",
  "FORMER_PEP_OLDER",
  "DOMESTIC_PEP",
  "FOREIGN_PEP",
  "CLOSE_ASSOCIATES",
  "FAMILY_MEMBERS",
] as const;

export const COUNTERPARTY_INTENDED_USE = [
  "TRANSFERS_OWN_WALLET",
  "TRANSFERS_FAMILY_FRIENDS",
  "INVESTMENTS",
  "GOODS_SERVICES",
  "DONATIONS",
] as const;

export const COUNTERPARTY_YEARLY_INCOME = [
  "INCOME_0_TO_50K",
  "INCOME_50K_TO_100K",
  "INCOME_100K_TO_250K",
  "INCOME_250K_TO_500K",
  "INCOME_500K_TO_750K",
  "INCOME_750K_TO_1M",
  "INCOME_ABOVE_1M",
] as const;

export const COUNTERPARTY_INDUSTRY_SECTORS = [
  "INVESTMENT",
  "HEDGE_FUND",
  "MONEY_SERVICE_BUSINESS",
  "STO_ISSUER",
  "PRECIOUS_METALS",
  "NON_PROFIT",
  "REGISTERED_INVESTMENT_ADVISOR",
  "AGRICULTURE_FORESTRY_FISHING_HUNTING",
  "MINING",
  "UTILITIES",
  "CONSTRUCTION",
  "MANUFACTURING",
  "WHOLESALE_TRADE",
  "RETAIL_TRADE",
  "TRANSPORTATION_WAREHOUSING",
  "INFORMATION",
  "FINANCE_INSURANCE",
  "REAL_ESTATE_RENTAL_LEASING",
  "PROFESSIONAL_SCIENTIFIC_TECHNICAL_SERVICES",
  "MANAGEMENT_OF_COMPANIES_ENTERPRISES",
  "ADMINISTRATIVE_SUPPORT_WASTE_MANAGEMENT_REMEDIATION_SERVICES",
  "EDUCATIONAL_SERVICES",
  "HEALTH_CARE_SOCIAL_ASSISTANCE",
  "ARTS_ENTERTAINMENT_RECREATION",
  "ACCOMMODATION_FOOD_SERVICES",
  "OTHER_SERVICES",
  "PUBLIC_ADMINISTRATION",
  "NOT_CLASSIFIED",
  "ADULT_ENTERTAINMENT",
  "AUCTIONS",
  "AUTOMOBILES",
  "BLOCKCHAIN",
  "CRYPTO",
  "DRUGS",
  "EXPORT_IMPORT",
  "E_COMMERCE",
  "FINANCIAL_INSTITUTION",
  "GAMBLING",
  "INSURANCE",
  "MARKET_MAKER",
  "SHELL_BANK",
  "TRAVEL_TRANSPORT",
  "WEAPONS",
] as const;

export interface CounterpartyBusinessIdentity {
  address: CounterpartyAddress;
}

export interface CounterpartyIndividualIdentity {
  firstName: string;
  middleName?: string;
  lastName: string;
  secondLastName?: string;
  dateOfBirth: string;
  phone: string;
  address: CounterpartyAddress;
}

export type CounterpartyIdentity = CounterpartyIndividualIdentity | CounterpartyBusinessIdentity;

export type CounterpartyStatus = "active" | "archived";

export type CounterpartyProviderData = Record<string, unknown>;

/** entityType discriminates the identity shape: checking it narrows `identity`. */
export type CounterpartyEntityIdentity =
  | { entityType: "individual"; identity: CounterpartyIndividualIdentity }
  | { entityType: "business"; identity: CounterpartyBusinessIdentity };

export type Counterparty = {
  id: string;
  organizationId: string;
  projectId: string | null;
  externalId: string | null;
  displayName: string;
  email: string;
  status: CounterpartyStatus;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
} & CounterpartyEntityIdentity;

export type CreateCounterpartyRequest = {
  externalId?: string;
  displayName: string;
  email: string;
} & CounterpartyEntityIdentity;

export interface UpdateCounterpartyRequest {
  externalId?: string | null;
  entityType?: CounterpartyEntityType;
  displayName?: string;
  email?: string;
  identity?: CounterpartyIdentity;
}

export interface CounterpartyResponse {
  counterparty: Counterparty;
}

export interface CounterpartyFieldOptions {
  entityTypes: readonly CounterpartyEntityType[];
  countries: readonly Country[];
  usStates: readonly { code: string; name: string }[];
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

export const COUNTERPARTY_ACCOUNT_KINDS = ["bank_account", "crypto_wallet"] as const;
export type CounterpartyAccountKind = (typeof COUNTERPARTY_ACCOUNT_KINDS)[number];

export type CounterpartyAccountStatus = "active" | "archived";

export type CounterpartyAccountDetails = Record<string, unknown>;

export type CounterpartyAccountProviderData = Record<string, unknown>;

export interface CounterpartyAccount {
  id: string;
  organizationId: string;
  projectId: string;
  counterpartyId: string;
  accountKind: CounterpartyAccountKind;
  label: string | null;
  details: CounterpartyAccountDetails;
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
