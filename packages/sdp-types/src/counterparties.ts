export type CounterpartyEntityType = "individual" | "business";

export const COUNTERPARTY_ID_TYPES = ["PAS", "DRV", "STA", "GOV"] as const;
export type CounterpartyIdType = (typeof COUNTERPARTY_ID_TYPES)[number];

export interface CounterpartyAddress {
  line1: string;
  line2?: string;
  city: string;
  postalCode?: string;
  countryCode: string;
  subdivisionCode?: string;
}

export interface CounterpartyGovernmentId {
  type: CounterpartyIdType;
  number: string;
  issueCountry: string;
  subdivisionCode?: string;
  issueDate?: string;
  expiryDate?: string;
}

export interface CounterpartyIdentity {
  firstName?: string;
  middleName?: string;
  lastName?: string;
  secondLastName?: string;
  dateOfBirth?: string;
  phone?: string;
  address?: CounterpartyAddress;
  birthCountryCode?: string;
  citizenshipCountryCode?: string;
  governmentId?: CounterpartyGovernmentId;
  [extension: string]: unknown;
}

export type CounterpartyStatus = "active" | "archived";

export interface Counterparty {
  id: string;
  organizationId: string;
  projectId: string | null;
  externalId: string | null;
  entityType: CounterpartyEntityType;
  displayName: string;
  email: string;
  identity: CounterpartyIdentity;
  status: CounterpartyStatus;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateCounterpartyRequest {
  externalId?: string;
  entityType: CounterpartyEntityType;
  displayName: string;
  email: string;
  identity?: CounterpartyIdentity;
}

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

export interface ListCounterpartiesResponse {
  counterparties: Counterparty[];
  total: number;
  page: number;
  pageSize: number;
}
