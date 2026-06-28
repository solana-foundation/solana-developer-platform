import type {
  CounterpartyEntityType,
  CounterpartyIdentity,
  CounterpartyProviderData,
  CounterpartyStatus,
} from "@sdp/types";
import type { BvnkCustomerResolution } from "@/lib/ramps/providers/bvnk";
import type { RepositoryDbClient } from "./base";

export function generateCounterpartyId(): string {
  return `counterparty_${crypto.randomUUID()}`;
}

export interface CounterpartyRow {
  id: string;
  organization_id: string;
  project_id: string;
  external_id: string | null;
  entity_type: CounterpartyEntityType;
  display_name: string;
  email: string;
  identity: CounterpartyIdentity;
  provider_data: CounterpartyProviderData;
  status: CounterpartyStatus;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateCounterpartyInput {
  organizationId: string;
  projectId: string;
  externalId: string | null;
  entityType: CounterpartyEntityType;
  displayName: string;
  email: string;
  identity: CounterpartyIdentity;
  providerData?: CounterpartyProviderData;
  createdBy: string | null;
}

export interface UpdateCounterpartyInput {
  counterpartyId: string;
  organizationId: string;
  projectId: string;
  externalId?: string | null;
  entityType?: CounterpartyEntityType;
  displayName?: string;
  email?: string;
  identity?: CounterpartyIdentity;
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
  includeArchived?: boolean;
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
  customer: Partial<BvnkCustomerResolution>;
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
  findActiveCounterpartyById(counterpartyId: string): Promise<CounterpartyRow | null>;
  findActiveCounterpartyByBvnkCustomerReference(
    customerReference: string
  ): Promise<CounterpartyRow | null>;
  upsertBvnkCustomerProviderData(params: UpsertBvnkCustomerProviderDataInput): Promise<void>;
  listCounterparties(params: ListCounterpartiesInput): Promise<ListCounterpartiesResult>;
}
