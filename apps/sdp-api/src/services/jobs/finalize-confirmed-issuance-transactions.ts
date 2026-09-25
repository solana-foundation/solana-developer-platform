/**
 * Background Job: Finalize Confirmed Issuance Transactions
 *
 * The unified transaction ledger reports a Solana `confirmed` issuance row as
 * provisional (never terminal), so this pass is what eventually turns one into
 * `finalized` — the only status the ledger reads as succeeded:
 *
 * Upgrade-only by design. A confirmed row whose status read comes back null or
 * with a transaction error keeps its status and rotates to the back of the
 * poll queue — the operation was already observed on chain, so reconciliation
 * must never introduce a new failure path for it. Rows stay confirmed when a
 * fork means finality never arrives; the ledger keeps them provisional, which
 * is the honest answer.
 *
 * Polls with searchTransactionHistory because a transaction typically
 * finalizes (~30s) and leaves the node's short recent-status cache before the
 * next tick on the managed five-minute cadence; without it every confirmed
 * row would read null forever. One page per tick as a least-recently-polled
 * queue (finalization_last_polled_at, never-polled first), so stuck rows
 * cannot starve the rows behind them. Past CONFIRMED_FINALIZATION_WINDOW_MS
 * (anchored on when the row actually reached confirmed) a still-confirmed row
 * ages out of the poll and rests at confirmed instead of costing an RPC
 * history search forever.
 */

import { createRpc, getSignatureStatuses, type SignatureStatusInfo } from "@sdp/rpc/solana";
import { assertIsSignature, commitmentComparator, type Signature } from "@solana/kit";
import {
  type ConfirmedIssuanceTransactionRow,
  type ConfirmedIssuanceTransactionVerdict,
  createSystemIssuanceTransactionsRepository,
} from "@/db/repositories";
import { internalError } from "@/lib/errors";
import { getLogger } from "@/runtime/logger";
import type { Env } from "@/types/env";

// getSignatureStatuses accepts at most 256 signatures per call.
const MAX_SIGNATURES_PER_BATCH = 256;
// A confirmed transaction finalizes within ~30s or never (fork, ledger reset);
// past this window a still-confirmed row ages out of the finalization poll and
// rests at confirmed.
const CONFIRMED_FINALIZATION_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface IssuanceFinalizationStats {
  polled: number;
  finalized: number;
}

type ConfirmedIssuanceTransaction = ConfirmedIssuanceTransactionRow & { signature: Signature };

function hasValidStoredSignature(
  row: ConfirmedIssuanceTransactionRow
): row is ConfirmedIssuanceTransaction {
  try {
    assertIsSignature(row.signature);
    return true;
  } catch (error) {
    getLogger().error(
      {
        transaction_id: row.id,
        organization_id: row.organizationId,
        error: error instanceof Error ? error.message : String(error),
      },
      "finalizeConfirmedIssuanceTransactions: stored issuance signature is invalid"
    );
    return false;
  }
}

/**
 * Advances confirmed issuance transactions to finalized once the cluster
 * reports finality.
 *
 * @param env - Runtime environment for RPC and repository construction.
 * @returns Poll statistics for the tick.
 */
export async function finalizeConfirmedIssuanceTransactions(
  env: Env
): Promise<IssuanceFinalizationStats> {
  const repo = createSystemIssuanceTransactionsRepository(env);
  const windowFloor = new Date(Date.now() - CONFIRMED_FINALIZATION_WINDOW_MS).toISOString();
  const candidates = await repo.listConfirmedTransactionsToPoll({
    confirmedAfter: windowFloor,
    limit: MAX_SIGNATURES_PER_BATCH,
  });
  if (candidates.length === 0) {
    return { polled: 0, finalized: 0 };
  }

  const { valid, invalid } = partitionByValidStoredSignature(candidates);
  const now = new Date().toISOString();
  const invalidVerdicts: ConfirmedIssuanceTransactionVerdict[] = invalid.map((row) => ({
    id: row.id,
    organizationId: row.organizationId,
    finalized: false,
    slot: null,
  }));

  if (valid.length === 0) {
    await repo.advanceConfirmedTransactions({ polled: invalidVerdicts, updatedAt: now });
    return { polled: candidates.length, finalized: 0 };
  }

  let statuses: Array<SignatureStatusInfo | null>;
  try {
    const rpc = createRpc(env);
    statuses = await getSignatureStatuses(
      rpc,
      valid.map((row) => row.signature),
      { searchTransactionHistory: true }
    );
  } catch (error) {
    getLogger().error(
      { error: error instanceof Error ? error.message : String(error) },
      "finalizeConfirmedIssuanceTransactions: getSignatureStatuses RPC call failed"
    );
    await repo.advanceConfirmedTransactions({
      polled: [
        ...invalidVerdicts,
        ...valid.map(
          (row): ConfirmedIssuanceTransactionVerdict => ({
            id: row.id,
            organizationId: row.organizationId,
            finalized: false,
            slot: null,
          })
        ),
      ],
      updatedAt: now,
    });
    return { polled: candidates.length, finalized: 0 };
  }

  if (statuses.length !== valid.length) {
    throw internalError(
      `getSignatureStatuses returned ${statuses.length} statuses for ${valid.length} signatures`
    );
  }

  const polled: ConfirmedIssuanceTransactionVerdict[] = [
    ...invalidVerdicts,
    ...valid.map((row, i): ConfirmedIssuanceTransactionVerdict => {
      const status = statuses[i];
      return status &&
        !status.err &&
        status.confirmationStatus !== null &&
        commitmentComparator(status.confirmationStatus, "finalized") >= 0
        ? {
            id: row.id,
            organizationId: row.organizationId,
            finalized: true,
            slot: Number(status.slot),
          }
        : { id: row.id, organizationId: row.organizationId, finalized: false, slot: null };
    }),
  ];

  await repo.advanceConfirmedTransactions({ polled, updatedAt: now });

  const finalized = polled.filter((row) => row.finalized);
  for (const row of finalized) {
    getLogger().info(
      {
        transaction_id: row.id,
        organization_id: row.organizationId,
      },
      "finalizeConfirmedIssuanceTransactions: issuance transaction finalized"
    );
  }
  return { polled: polled.length, finalized: finalized.length };
}

function partitionByValidStoredSignature(rows: ConfirmedIssuanceTransactionRow[]): {
  valid: ConfirmedIssuanceTransaction[];
  invalid: ConfirmedIssuanceTransactionRow[];
} {
  const valid: ConfirmedIssuanceTransaction[] = [];
  const invalid: ConfirmedIssuanceTransactionRow[] = [];
  for (const row of rows) {
    if (hasValidStoredSignature(row)) {
      valid.push(row);
    } else {
      invalid.push(row);
    }
  }
  return { valid, invalid };
}
