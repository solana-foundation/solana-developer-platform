import type {
  UnifiedTransaction,
  UnifiedTransactionModule,
  UnifiedTransactionStatus,
} from "@sdp/types";
import type { RepositoryDbClient } from "./base";

export interface UnifiedTransactionModuleWalletScope {
  module: UnifiedTransactionModule;
  custodyWalletIds: readonly string[];
}

export interface ListUnifiedTransactionsInput {
  organizationId: string;
  projectId: string | null;
  moduleWalletScopes?: readonly UnifiedTransactionModuleWalletScope[];
  modules: readonly UnifiedTransactionModule[];
  module?: UnifiedTransactionModule;
  kind?: string;
  status?: UnifiedTransactionStatus;
  custodyWalletId?: string;
  counterpartyId?: string;
  token?: string;
  search?: string;
  createdAtFrom?: string;
  createdAtTo?: string;
  cursor?: string;
  limit: number;
}

export interface ListUnifiedTransactionsResult {
  rows: UnifiedTransaction[];
  nextCursor: string | null;
}

export interface UnifiedTransactionsRepository {
  list(input: ListUnifiedTransactionsInput): Promise<ListUnifiedTransactionsResult>;
}

export type UnifiedTransactionsRepositoryDb = RepositoryDbClient;
