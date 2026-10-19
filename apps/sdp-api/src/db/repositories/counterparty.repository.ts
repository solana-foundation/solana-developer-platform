import type { CounterpartyRow } from "@sdp/payments/counterparty";
import type { SdpEnvironment } from "@sdp/types/api-keys";
import type { CounterpartyEntityType, CounterpartyProviderData } from "@sdp/types/counterparties";
import type { RampProviderId } from "@sdp/types/provider-access";
import type { DatabaseClient as RepositoryDbClient } from "@/db/client";

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
    /**
     * `any` for an access check (HOO-1918): the row must belong to the project
     * whatever its status, so the retry of a request that archived it is still
     * answered.
     */
    status?: "active" | "any";
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
  mutateProviderData(params: MutateCounterpartyProviderDataInput): Promise<CounterpartyRow | null>;
  listCounterparties(params: ListCounterpartiesInput): Promise<ListCounterpartiesResult>;
}
