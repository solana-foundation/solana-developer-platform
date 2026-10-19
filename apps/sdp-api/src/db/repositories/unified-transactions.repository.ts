import type { RampProviderId } from "@sdp/types/provider-access";
import type {
  PaymentTransactionKind,
  UnifiedTransaction,
  UnifiedTransactionModule,
  UnifiedTransactionStatus,
} from "@sdp/types/unified-transactions";
import type { DatabaseClient as RepositoryDbClient } from "@/db/client";

export interface UnifiedTransactionModuleWalletScope {
  module: UnifiedTransactionModule;
  custodyWalletIds: readonly string[];
}

export interface ListUnifiedTransactionsInput {
  organizationId: string;
  projectId: string | null;
  moduleWalletScopes?: readonly UnifiedTransactionModuleWalletScope[];
  modules: readonly UnifiedTransactionModule[];
  /**
   * The kinds of Payments row listed when `modules` includes payments; never
   * empty then (the caller drops payments instead).
   */
  paymentKinds: readonly PaymentTransactionKind[];
  /** Ramp providers the release channel leaves out: their Payments rows are not listed. */
  excludedRampProviders: readonly RampProviderId[];
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
