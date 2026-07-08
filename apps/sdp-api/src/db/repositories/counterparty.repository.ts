import type { CounterpartyRow } from "@sdp/payments";
import type {
  CounterpartyEntityType,
  CounterpartyIdentity,
  CounterpartyProviderData,
} from "@sdp/types";
import type { BvnkCustomerResolution } from "@/lib/ramps/providers/bvnk/provider-data";
import type { RepositoryDbClient } from "./base";

export type { CounterpartyRow } from "@sdp/payments";

export function generateCounterpartyId(): string {
  return `counterparty_${crypto.randomUUID()}`;
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
