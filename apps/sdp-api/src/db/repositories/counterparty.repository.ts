import type { CounterpartyEntityType, CounterpartyIdentity, CounterpartyStatus } from "@sdp/types";
import type { RepositoryDbClient } from "./base";

export function generateCounterpartyId(): string {
  return `counterparty_${crypto.randomUUID()}`;
}

export interface CounterpartyRow {
  id: string;
  organization_id: string;
  project_id: string | null;
  external_id: string | null;
  entity_type: CounterpartyEntityType;
  display_name: string;
  email: string;
  identity: CounterpartyIdentity;
  status: CounterpartyStatus;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateCounterpartyInput {
  organizationId: string;
  projectId: string | null;
  externalId: string | null;
  entityType: CounterpartyEntityType;
  displayName: string;
  email: string;
  identity: CounterpartyIdentity;
  createdBy: string | null;
}

export interface UpdateCounterpartyInput {
  counterpartyId: string;
  organizationId: string;
  externalId?: string | null;
  entityType?: CounterpartyEntityType;
  displayName?: string;
  email?: string;
  identity?: CounterpartyIdentity;
}

export interface ArchiveCounterpartyInput {
  counterpartyId: string;
  organizationId: string;
}

export interface ListCounterpartiesInput {
  organizationId: string;
  includeArchived?: boolean;
  limit: number;
  offset: number;
}

export interface ListCounterpartiesResult {
  rows: CounterpartyRow[];
  total: number;
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
  }): Promise<CounterpartyRow | null>;
  getCounterpartyByExternalId(params: {
    externalId: string;
    organizationId: string;
  }): Promise<CounterpartyRow | null>;
  listCounterparties(params: ListCounterpartiesInput): Promise<ListCounterpartiesResult>;
}
