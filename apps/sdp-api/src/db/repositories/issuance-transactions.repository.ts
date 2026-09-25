/**
 * Issuance-transaction ledger access for system reconciliation paths.
 *
 * The unified transaction ledger reports Solana `confirmed` issuance rows as
 * provisional, so a finality-aware reconciler owns the only write that turns
 * one into `finalized`: an observation made from the cluster, guarded on the
 * row still being confirmed. Tenant code cannot reach this repository — every
 * method is system-only.
 */

import type { RepositoryDbClient } from "./base";

export interface ConfirmedIssuanceTransactionRow {
  id: string;
  organizationId: string;
  signature: string;
  slot: number | null;
}

export interface ConfirmedIssuanceTransactionVerdict {
  id: string;
  organizationId: string;
  finalized: boolean;
  slot: number | null;
}

export interface IssuanceTransactionsRepository {
  /**
   * Lists the page of confirmed issuance transactions whose finality should be
   * polled, least-recently-polled first. There is no age cutoff: rows
   * confirmed before this reconciler deployed, or stranded by an outage
   * longer than any window, stay in the queue until the cluster verifies
   * their finality — the unified ledger reads them as provisional until then,
   * so polling is the only finality-verified recovery path.
   *
   * @param params - Page size.
   * @returns The next page of the finalization poll queue.
   */
  listConfirmedTransactionsToPoll(params: {
    limit: number;
  }): Promise<ConfirmedIssuanceTransactionRow[]>;

  /**
   * Records one finalization poll over a page of confirmed issuance
   * transactions in one guarded statement: every polled row gets
   * finalization_last_polled_at stamped (rotating it to the back of the
   * queue), while only rows the cluster reported finalized advance — and only
   * while still confirmed. Status history is appended for the rows actually
   * advanced to finalized and nothing else: a provisional poll never writes
   * a terminal history entry. A concurrent writer that already advanced a
   * row makes this a no-op for it; the transition is upgrade-only and never
   * introduces a failure status for a row whose funds were already observed.
   *
   * @param params - The page's verdicts and the poll timestamp.
   * @returns The ids of the transactions this statement advanced.
   */
  advanceConfirmedTransactions(params: {
    polled: ConfirmedIssuanceTransactionVerdict[];
    updatedAt: string;
  }): Promise<{ advancedTransactionIds: string[] }>;
}

export interface IssuanceTransactionsRepositoryContext {
  db: RepositoryDbClient;
}
