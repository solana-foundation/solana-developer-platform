import type { CounterpartyRow } from "@sdp/payments";
import type {
  CounterpartyEntityType,
  CounterpartyProviderData,
  RampProviderId,
  SdpEnvironment,
} from "@sdp/types";
import type { RepositoryDbClient } from "./base";
import type { BvnkCustomerProviderAccountMetadata } from "./counterparty-provider-account.repository";

export type { CounterpartyRow } from "@sdp/payments";
export { generateCounterpartyId } from "@sdp/payments";

export interface CreateCounterpartyInput {
  organizationId: string;
  projectId: string;
  externalId: string | null;
  entityType: CounterpartyEntityType;
  displayName: string;
  providerData: CounterpartyProviderData;
  createdBy: string | null;
}

export interface UpdateCounterpartyInput {
  counterpartyId: string;
  organizationId: string;
  projectId: string;
  externalId?: string | null;
  entityType?: CounterpartyEntityType;
  displayName?: string;
  providerData?: CounterpartyProviderData;
}

export interface ArchiveCounterpartyInput {
  counterpartyId: string;
  organizationId: string;
  projectId: string;
}

export interface ListCounterpartiesInput {
  organizationId: string;
  projectId: string;
  includeArchived: boolean;
  limit: number;
  offset: number;
}

export interface ListCounterpartiesResult {
  rows: CounterpartyRow[];
  total: number;
}

export interface UpsertBvnkCustomerProviderDataInput {
  counterpartyId: string;
  organizationId: string;
  projectId: string;
  customer: {
    customerReference: string;
    residenceCountryCode?: BvnkCustomerProviderAccountMetadata["residenceCountryCode"];
    session?: BvnkCustomerProviderAccountMetadata["session"];
  };
}

export interface MutateCounterpartyProviderDataInput {
  counterpartyId: string;
  organizationId: string;
  projectId: string;
  mutate: (current: CounterpartyProviderData) => CounterpartyProviderData;
}

export interface CounterpartiesRepositoryContext {
  db: RepositoryDbClient;
}

export interface CounterpartiesRepository {
  createCounterparty(input: CreateCounterpartyInput): Promise<CounterpartyRow | null>;
  updateCounterparty(input: UpdateCounterpartyInput): Promise<CounterpartyRow | null>;
  archiveCounterparty(input: ArchiveCounterpartyInput): Promise<CounterpartyRow | null>;
  getCounterpartyById(params: {
    counterpartyId: string;
    organizationId: string;
    projectId: string;
  }): Promise<CounterpartyRow | null>;
  getCounterpartyByExternalId(params: {
    externalId: string;
    organizationId: string;
    projectId: string;
  }): Promise<CounterpartyRow | null>;
  findActiveCounterpartyById(params: {
    counterpartyId: string;
    environment: SdpEnvironment;
  }): Promise<CounterpartyRow | null>;
  findActiveCounterpartyByProviderCustomerReference(params: {
    provider: RampProviderId;
    providerCustomerReference: string;
    environment: SdpEnvironment;
  }): Promise<CounterpartyRow | null>;
  findCounterpartyByMuralOrganizationId(organizationId: string): Promise<CounterpartyRow | null>;
  mutateProviderData(params: MutateCounterpartyProviderDataInput): Promise<CounterpartyRow | null>;
  upsertBvnkCustomerProviderData(params: UpsertBvnkCustomerProviderDataInput): Promise<void>;
  patchMuralOrganizationById(params: {
    organizationId: string;
    organization: Record<string, unknown>;
  }): Promise<void>;
  listCounterparties(params: ListCounterpartiesInput): Promise<ListCounterpartiesResult>;
}
