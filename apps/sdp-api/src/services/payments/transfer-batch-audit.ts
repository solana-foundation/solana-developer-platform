import { getDb } from "@/db";
import type {
  PaymentTransferBatchesRepository,
  PaymentTransferBatchRow,
  TransferBatchStatusTransition,
} from "@/db/repositories/payment-transfer-batches.repository";
import type { PaymentsRepository } from "@/db/repositories/payments.repository";
import { createKVStoreSet } from "@/runtime/kv-redis";
import { getLogger } from "@/runtime/logger";
import { AuditService } from "@/services/audit.service";
import type { Env } from "@/types/env";

/**
 * Appends the audit-ledger outcome for a transfer batch whose status write
 * just made it terminal. The intent was admitted before the batch existed;
 * chunks confirm asynchronously, so the outcome is written by whichever writer
 * observes the terminal transition under the batch row lock — the request when
 * every chunk failed before broadcast, otherwise the pending-transfers job.
 * Never throws: the chain verdict is already durable on the batch, and an
 * outcome that does not land is re-appended by the pending-transfers job.
 *
 * @param params.env - Worker environment for the ledger and its checkpoint store.
 * @param params.transition - The batch status write to inspect.
 * @param params.batches - Batches repository scoped to the caller.
 * @param params.payments - Payments repository scoped to the caller.
 */
export async function recordTransferBatchAuditOutcome(params: {
  env: Env;
  transition: TransferBatchStatusTransition | null;
  batches: PaymentTransferBatchesRepository;
  payments: PaymentsRepository;
}): Promise<void> {
  if (params.transition === null || !params.transition.becameTerminal) {
    return;
  }
  await appendTransferBatchAuditOutcome({ ...params, batch: params.transition.batch });
}

/**
 * Appends the outcome for a terminal batch and stamps it as recorded once the
 * ledger write is durable. Only a fully confirmed batch is a success; the
 * outcome lists each chunk's transfer id, signature and status. Never throws.
 *
 * @param params.env - Worker environment for the ledger and its checkpoint store.
 * @param params.batch - Terminal batch carrying its audit intent id.
 * @param params.batches - Batches repository scoped to the caller.
 * @param params.payments - Payments repository scoped to the caller.
 */
export async function appendTransferBatchAuditOutcome(params: {
  env: Env;
  batch: PaymentTransferBatchRow;
  batches: PaymentTransferBatchesRepository;
  payments: PaymentsRepository;
}): Promise<void> {
  const { batch } = params;
  if (batch.audit_intent_id === null) {
    return;
  }

  let transfers: Array<{ transferId: string; signature: string | null; status: string }> | null =
    null;
  try {
    const recipients = await params.batches.listTransferRecipientsByBatch({
      batchId: batch.id,
      organizationId: batch.organization_id,
      projectId: batch.project_id,
      limit: 500,
      offset: 0,
    });
    const transferIds = Array.from(
      new Set(
        recipients.rows
          .map((recipient) => recipient.transfer_id)
          .filter((transferId): transferId is string => transferId !== null)
      )
    );
    const rows = await params.payments.listTransfersByIds({
      transferIds,
      organizationId: batch.organization_id,
      projectId: batch.project_id,
    });
    transfers = rows.map((row) => ({
      transferId: row.id,
      signature: row.signature,
      status: row.status,
    }));
  } catch (error) {
    getLogger().error(
      { event: "transfer_batch_audit_outcome_detail_failed", batchId: batch.id, error },
      "Transfer batch outcome is recorded without its chunk detail"
    );
  }

  const recorded = await new AuditService(
    getDb(params.env),
    createKVStoreSet(params.env).cache
  ).completeCriticalSystem(
    {
      id: batch.audit_intent_id,
      entry: {
        organizationId: batch.organization_id,
        action: "transfer",
        resourceType: "payment_transfer_batch",
        resourceId: batch.id,
      },
    },
    {
      status: batch.status === "confirmed" ? "success" : "failure",
      metadata: { batchStatus: batch.status, transfers },
    }
  );
  if (!recorded) {
    return;
  }
  try {
    await params.batches.markTransferBatchAuditOutcomeRecorded({
      batchId: batch.id,
      organizationId: batch.organization_id,
      projectId: batch.project_id,
    });
  } catch (error) {
    getLogger().error(
      { event: "transfer_batch_audit_outcome_stamp_failed", batchId: batch.id, error },
      "Transfer batch outcome is durable but unstamped; the sweep may append it again"
    );
  }
}
