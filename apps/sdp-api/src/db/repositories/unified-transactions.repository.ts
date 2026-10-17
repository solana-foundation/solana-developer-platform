import type {
  PaymentTransactionKind,
  RampProviderId,
  UnifiedTransaction,
  UnifiedTransactionModule,
  UnifiedTransactionStatus,
} from "@sdp/types";
import type { RepositoryDbClient } from "./base";

export interface ListUnifiedTransactionsInput {
  organizationId: string;
  projectId: string | null;
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
