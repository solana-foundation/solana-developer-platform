import type {
  CounterpartyAccountDetails,
  CounterpartyAccountKind,
  CounterpartyAccountProviderData,
  CounterpartyAccountStatus,
} from "@sdp/types/counterparties";

export function generateCounterpartyAccountId(): string {
  return `counterparty_account_${crypto.randomUUID()}`;
}

export interface CounterpartyAccountRow {
  id: string;
  organization_id: string;
  project_id: string;
  counterparty_id: string;
  account_kind: CounterpartyAccountKind;
  label: string | null;
  details: CounterpartyAccountDetails;
  provider_account_data: CounterpartyAccountProviderData;
  status: CounterpartyAccountStatus;
  created_at: string;
  updated_at: string;
}

export interface CreateCounterpartyAccountInput {
  organizationId: string;
  projectId: string;
  counterpartyId: string;
  accountKind: CounterpartyAccountKind;
  label?: string | null;
  details?: CounterpartyAccountDetails;
  providerAccountData?: CounterpartyAccountProviderData;
}

export interface UpdateCounterpartyAccountInput {
  counterpartyAccountId: string;
  counterpartyId: string;
  organizationId: string;
  projectId: string;
  label?: string | null;
  details?: CounterpartyAccountDetails;
  providerAccountData?: CounterpartyAccountProviderData;
}

export interface ArchiveCounterpartyAccountInput {
  counterpartyAccountId: string;
  counterpartyId: string;
  organizationId: string;
  projectId: string;
}

export interface ListCounterpartyAccountsByCounterpartyInput {
  counterpartyId: string;
  organizationId: string;
  projectId: string;
  accountKind?: CounterpartyAccountKind;
  includeArchived?: boolean;
  limit: number;
  offset: number;
}

export interface ListCounterpartyAccountsResult {
  rows: CounterpartyAccountRow[];
  total: number;
}

interface BatchRecipientRow {
  counterparty_id: string;
  counterparty_display_name: string;
  account_id: string;
  account_label: string | null;
  address: string;
}

interface ListBatchRecipientsInput {
  organizationId: string;
  projectId: string;
  search?: string;
  accountIds?: string[];
  limit: number;
  offset: number;
}

interface ListBatchRecipientsResult {
  rows: BatchRecipientRow[];
  total: number;
}

export interface CounterpartyAccountsRepository {
  createCounterpartyAccount(
    input: CreateCounterpartyAccountInput
  ): Promise<CounterpartyAccountRow | null>;
  updateCounterpartyAccount(
    input: UpdateCounterpartyAccountInput
  ): Promise<CounterpartyAccountRow | null>;
  archiveCounterpartyAccount(
    input: ArchiveCounterpartyAccountInput
  ): Promise<CounterpartyAccountRow | null>;
  getCounterpartyAccountById(params: {
    counterpartyAccountId: string;
    counterpartyId: string;
    organizationId: string;
    projectId: string;
    /**
     * `any` for an access check (HOO-1918): the row must belong to the project
     * whatever its status, so the retry of a request that archived it is still
     * answered.
     */
    status?: "active" | "any";
  }): Promise<CounterpartyAccountRow | null>;
  getCounterpartyAccountByIdInProject(params: {
    counterpartyAccountId: string;
    organizationId: string;
    projectId: string;
  }): Promise<CounterpartyAccountRow | null>;
  listCounterpartyAccountsByIdsInProject(params: {
    counterpartyAccountIds: string[];
    organizationId: string;
    projectId: string;
    /**
     * `any` for an access check (HOO-1918): the account must belong to the
     * project whatever its status, so a request that already ran is still
     * answered after the account is archived.
     */
    status?: "active" | "any";
  }): Promise<CounterpartyAccountRow[]>;
  listCounterpartyAccountsByCounterparty(
    params: ListCounterpartyAccountsByCounterpartyInput
  ): Promise<ListCounterpartyAccountsResult>;
  listBatchRecipients(params: ListBatchRecipientsInput): Promise<ListBatchRecipientsResult>;
}
