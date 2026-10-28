import { z } from "zod";
import type { DatabaseClient as AppDb, DatabaseExecutor } from "@/db/client";
import { parsePostgresJson } from "@/db/postgres-utils";
import { internalError } from "@/lib/errors";
import { parseNullableCustodyWalletId } from "./payment-execution-identity";
import {
  type ClaimFailedTransferRecipientsInput,
  type CreatePaymentTransferBatchInput,
  type CreatePaymentTransferBatchWithRecipientsInput,
  type CreatePaymentTransferRecipientInput,
  type DeletePaymentTransferBatchInput,
  type DeletePaymentTransferRecipientInput,
  deriveTransferBatchStatus,
  type GetPaymentTransferBatchInput,
  type GetPaymentTransferRecipientInput,
  generatePaymentTransferBatchId,
  generatePaymentTransferBatchRetryId,
  generatePaymentTransferRecipientId,
  type ListPaymentTransferBatchesInput,
  type ListPaymentTransferBatchesResult,
  type ListPaymentTransferRecipientsInput,
  type ListPaymentTransferRecipientsResult,
  type PaymentTransferBatchesRepository,
  type PaymentTransferBatchRetryRow,
  type PaymentTransferBatchRow,
  type PaymentTransferRecipientRow,
  type RecomputeTransferBatchStatusInput,
  type SettlePaymentTransferBatchInput,
  type StrandedRecipientCutoff,
  type UpdatePaymentTransferBatchInput,
  type UpdatePaymentTransferRecipientInput,
  type UpdatePaymentTransferRecipientsStatusInput,
  type UpsertPaymentTransferBatchInput,
  type UpsertPaymentTransferRecipientInput,
} from "./payment-transfer-batches.repository";

function mapPaymentTransferBatchRow(row: Record<string, unknown>): PaymentTransferBatchRow {
  return {
    id: row.id as string,
    organization_id: row.organization_id as string,
    project_id: row.project_id as string,
    external_id: (row.external_id as string | null | undefined) ?? null,
    source_custody_wallet_id: parseNullableCustodyWalletId(row.source_custody_wallet_id),
    source_wallet_id: row.source_wallet_id as string,
    source_address: row.source_address as string,
    token: row.token as string,
    status: row.status as PaymentTransferBatchRow["status"],
    total_amount: (row.total_amount as string | null | undefined) ?? null,
    recipient_count: row.recipient_count as number,
    transaction_count: row.transaction_count as number,
    options: row.options as Record<string, unknown>,
    error: (row.error as string | null | undefined) ?? null,
    initiated_by_key_id: (row.initiated_by_key_id as string | null | undefined) ?? null,
    idempotency_key: (row.idempotency_key as string | null | undefined) ?? null,
    idempotency_fingerprint: (row.idempotency_fingerprint as string | null | undefined) ?? null,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

function mapPaymentTransferRecipientRow(row: Record<string, unknown>): PaymentTransferRecipientRow {
  return {
    id: row.id as string,
    batch_id: row.batch_id as string,
    organization_id: row.organization_id as string,
    project_id: row.project_id as string,
    transfer_id: (row.transfer_id as string | null | undefined) ?? null,
    external_id: (row.external_id as string | null | undefined) ?? null,
    counterparty_id: row.counterparty_id as string,
    counterparty_account_id: row.counterparty_account_id as string,
    destination_address: row.destination_address as string,
    amount: row.amount as string,
    status: row.status as PaymentTransferRecipientRow["status"],
    error: (row.error as string | null | undefined) ?? null,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

function jsonParam(value: Record<string, unknown> | undefined): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

function buildScopeWhere(params: {
  organizationId: string;
  projectId: string;
  extraClauses?: string[];
  extraValues?: unknown[];
}) {
  const clauses = ["organization_id = ?", "project_id = ?"];
  const values: unknown[] = [params.organizationId, params.projectId];

  if (params.extraClauses?.length) {
    clauses.push(...params.extraClauses);
  }

  if (params.extraValues?.length) {
    values.push(...params.extraValues);
  }

  return {
    where: clauses.join(" AND "),
    values,
  };
}

async function getTransferBatchByIdInternal(
  db: DatabaseExecutor,
  input: GetPaymentTransferBatchInput
): Promise<PaymentTransferBatchRow | null> {
  const scope = buildScopeWhere({
    organizationId: input.organizationId,
    projectId: input.projectId,
    extraClauses: ["id = ?", "status <> 'archived'"],
    extraValues: [input.batchId],
  });

  const row = await db
    .prepare(`SELECT * FROM payment_transfer_batches WHERE ${scope.where}`)
    .bind(...scope.values)
    .first<Record<string, unknown>>();

  return row ? mapPaymentTransferBatchRow(row) : null;
}

async function getTransferRecipientByIdInternal(
  db: DatabaseExecutor,
  input: GetPaymentTransferRecipientInput
): Promise<PaymentTransferRecipientRow | null> {
  const scope = buildScopeWhere({
    organizationId: input.organizationId,
    projectId: input.projectId,
    extraClauses: ["id = ?", "status <> 'archived'"],
    extraValues: [input.recipientId],
  });

  const row = await db
    .prepare(`SELECT * FROM payment_transfer_recipients WHERE ${scope.where}`)
    .bind(...scope.values)
    .first<Record<string, unknown>>();

  return row ? mapPaymentTransferRecipientRow(row) : null;
}

async function insertTransferBatch(
  db: DatabaseExecutor,
  input: CreatePaymentTransferBatchInput
): Promise<PaymentTransferBatchRow> {
  const batchId = generatePaymentTransferBatchId();
  const row = await db
    .prepare(
      `INSERT INTO payment_transfer_batches (
         id,
         organization_id,
         project_id,
         external_id,
         source_custody_wallet_id,
         source_wallet_id,
         source_address,
         token,
         status,
         total_amount,
         recipient_count,
         transaction_count,
         options,
         error,
         initiated_by_key_id,
         idempotency_key,
         idempotency_fingerprint
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?::jsonb, '{}'::jsonb), ?, ?, ?, ?)
       RETURNING *`
    )
    .bind(
      batchId,
      input.organizationId,
      input.projectId,
      input.externalId ?? null,
      input.sourceCustodyWalletId,
      input.sourceWalletId,
      input.sourceAddress,
      input.token,
      input.status ?? "pending",
      input.totalAmount ?? null,
      input.recipientCount ?? 0,
      input.transactionCount ?? 0,
      jsonParam(input.options),
      input.error ?? null,
      input.initiatedByKeyId ?? null,
      input.idempotencyKey ?? null,
      input.idempotencyFingerprint ?? null
    )
    .first<Record<string, unknown>>();

  if (!row) {
    throw internalError("payment_transfer_batches INSERT ... RETURNING returned no row");
  }
  return mapPaymentTransferBatchRow(row);
}

async function insertTransferRecipients(
  db: DatabaseExecutor,
  inputs: CreatePaymentTransferRecipientInput[]
): Promise<PaymentTransferRecipientRow[]> {
  if (inputs.length === 0) {
    return [];
  }

  const rowPlaceholder = `(${Array(13).fill("?").join(", ")})`;
  const values = inputs.flatMap((input) => [
    generatePaymentTransferRecipientId(),
    input.batchId,
    input.organizationId,
    input.projectId,
    input.transferId ?? null,
    input.externalId ?? null,
    input.counterpartyId,
    input.counterpartyAccountId,
    input.destinationAddress,
    input.amount,
    input.status ?? "pending",
    input.error ?? null,
    input.attemptLastValidBlockHeight === undefined || input.attemptLastValidBlockHeight === null
      ? null
      : input.attemptLastValidBlockHeight.toString(),
  ]);

  const result = await db
    .prepare(
      `INSERT INTO payment_transfer_recipients (
         id,
         batch_id,
         organization_id,
         project_id,
         transfer_id,
         external_id,
         counterparty_id,
         counterparty_account_id,
         destination_address,
         amount,
         status,
         error,
         attempt_last_valid_block_height
       ) VALUES ${inputs.map(() => rowPlaceholder).join(", ")}
       RETURNING *`
    )
    .bind(...values)
    .all<Record<string, unknown>>();

  if (result.results.length !== inputs.length) {
    throw internalError("payment_transfer_recipients bulk INSERT returned an unexpected count");
  }
  return result.results.map(mapPaymentTransferRecipientRow);
}

export function createPostgresPaymentTransferBatchesRepository(
  db: AppDb
): PaymentTransferBatchesRepository {
  return {
    async createTransferBatchWithRecipients(input: CreatePaymentTransferBatchWithRecipientsInput) {
      return db.transaction(async (tx) => {
        const batch = await insertTransferBatch(tx, input.batch);
        const recipients = await insertTransferRecipients(
          tx,
          input.recipients.map((recipient) => ({ ...recipient, batchId: batch.id }))
        );
        return { batch, recipients };
      });
    },

    async findTransferBatchByIdempotency({ organizationId, projectId, idempotencyKey }) {
      const row = await db
        .prepare(
          `SELECT * FROM payment_transfer_batches
           WHERE organization_id = ?
             AND project_id = ?
             AND idempotency_key = ?`
        )
        .bind(organizationId, projectId, idempotencyKey)
        .first<Record<string, unknown>>();

      return row ? mapPaymentTransferBatchRow(row) : null;
    },

    async upsertTransferBatch(input: UpsertPaymentTransferBatchInput) {
      const batchId = input.batchId ?? generatePaymentTransferBatchId();
      const row = await db
        .prepare(
          `INSERT INTO payment_transfer_batches (
             id,
             organization_id,
             project_id,
             external_id,
             source_custody_wallet_id,
             source_wallet_id,
             source_address,
             token,
             status,
             total_amount,
             recipient_count,
             transaction_count,
             options,
             error,
             initiated_by_key_id
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?::jsonb, '{}'::jsonb), ?, ?)
           ON CONFLICT (id) DO UPDATE SET
             external_id = EXCLUDED.external_id,
             source_custody_wallet_id = EXCLUDED.source_custody_wallet_id,
             source_wallet_id = EXCLUDED.source_wallet_id,
             source_address = EXCLUDED.source_address,
             token = EXCLUDED.token,
             status = EXCLUDED.status,
             total_amount = EXCLUDED.total_amount,
             recipient_count = EXCLUDED.recipient_count,
             transaction_count = EXCLUDED.transaction_count,
             options = EXCLUDED.options,
             error = EXCLUDED.error,
             initiated_by_key_id = EXCLUDED.initiated_by_key_id,
             updated_at = sdp_iso_now()
           WHERE payment_transfer_batches.organization_id = EXCLUDED.organization_id
             AND payment_transfer_batches.project_id = EXCLUDED.project_id
           RETURNING *`
        )
        .bind(
          batchId,
          input.organizationId,
          input.projectId,
          input.externalId ?? null,
          input.sourceCustodyWalletId,
          input.sourceWalletId,
          input.sourceAddress,
          input.token,
          input.status ?? "pending",
          input.totalAmount ?? null,
          input.recipientCount ?? 0,
          input.transactionCount ?? 0,
          jsonParam(input.options),
          input.error ?? null,
          input.initiatedByKeyId ?? null
        )
        .first<Record<string, unknown>>();

      if (!row) {
        throw internalError("payment_transfer_batches UPSERT returned no row");
      }
      return mapPaymentTransferBatchRow(row);
    },

    async updateTransferBatch(input: UpdatePaymentTransferBatchInput) {
      const scope = buildScopeWhere({
        organizationId: input.organizationId,
        projectId: input.projectId,
        extraClauses: ["id = ?", "status <> 'archived'"],
        extraValues: [input.batchId],
      });

      const row = await db
        .prepare(
          `UPDATE payment_transfer_batches
             SET external_id = CASE WHEN ?::boolean THEN ? ELSE external_id END,
                 source_wallet_id = COALESCE(?, source_wallet_id),
                 source_address = COALESCE(?, source_address),
                 token = COALESCE(?, token),
                 status = COALESCE(?, status),
                 total_amount = CASE WHEN ?::boolean THEN ? ELSE total_amount END,
                 recipient_count = COALESCE(?, recipient_count),
                 transaction_count = COALESCE(?, transaction_count),
                 options = CASE WHEN ?::boolean THEN ?::jsonb ELSE options END,
                 error = CASE WHEN ?::boolean THEN ? ELSE error END,
                 initiated_by_key_id = CASE WHEN ?::boolean THEN ? ELSE initiated_by_key_id END,
                 updated_at = sdp_iso_now()
           WHERE ${scope.where}
           RETURNING *`
        )
        .bind(
          input.externalId !== undefined,
          input.externalId ?? null,
          input.sourceWalletId ?? null,
          input.sourceAddress ?? null,
          input.token ?? null,
          input.status ?? null,
          input.totalAmount !== undefined,
          input.totalAmount ?? null,
          input.recipientCount ?? null,
          input.transactionCount ?? null,
          input.options !== undefined,
          jsonParam(input.options),
          input.error !== undefined,
          input.error ?? null,
          input.initiatedByKeyId !== undefined,
          input.initiatedByKeyId ?? null,
          ...scope.values
        )
        .first<Record<string, unknown>>();

      return row ? mapPaymentTransferBatchRow(row) : null;
    },

    async deleteTransferBatch(input: DeletePaymentTransferBatchInput) {
      const scope = buildScopeWhere({
        organizationId: input.organizationId,
        projectId: input.projectId,
        extraClauses: ["id = ?", "status <> 'archived'"],
        extraValues: [input.batchId],
      });

      const row = await db
        .prepare(
          `UPDATE payment_transfer_batches
              SET status = 'archived',
                  updated_at = sdp_iso_now()
            WHERE ${scope.where}
            RETURNING *`
        )
        .bind(...scope.values)
        .first<Record<string, unknown>>();

      return row ? mapPaymentTransferBatchRow(row) : null;
    },

    async getTransferBatchById(input: GetPaymentTransferBatchInput) {
      return getTransferBatchByIdInternal(db, input);
    },

    async listTransferBatches(
      input: ListPaymentTransferBatchesInput
    ): Promise<ListPaymentTransferBatchesResult> {
      const extraClauses: string[] = [];
      const extraValues: unknown[] = [];

      if (input.sourceCustodyWalletId !== undefined) {
        extraClauses.push("source_custody_wallet_id = ?");
        extraValues.push(input.sourceCustodyWalletId);
      }
      if (input.walletId) {
        extraClauses.push("source_wallet_id = ?");
        extraValues.push(input.walletId);
      }
      if (input.token) {
        extraClauses.push("token = ?");
        extraValues.push(input.token);
      }
      if (input.status) {
        extraClauses.push("status = ?");
        extraValues.push(input.status);
      } else {
        extraClauses.push("status <> 'archived'");
      }
      if (input.externalId) {
        extraClauses.push("external_id = ?");
        extraValues.push(input.externalId);
      }
      if (input.createdAtFrom) {
        extraClauses.push("created_at >= ?");
        extraValues.push(input.createdAtFrom);
      }
      if (input.createdAtTo) {
        extraClauses.push("created_at <= ?");
        extraValues.push(input.createdAtTo);
      }

      const scope = buildScopeWhere({
        organizationId: input.organizationId,
        projectId: input.projectId,
        extraClauses,
        extraValues,
      });

      const [rowsResult, countRow] = await Promise.all([
        db
          .prepare(
            `SELECT *
               FROM payment_transfer_batches
              WHERE ${scope.where}
              ORDER BY created_at DESC
              LIMIT ? OFFSET ?`
          )
          .bind(...scope.values, input.limit, input.offset)
          .all<Record<string, unknown>>(),
        db
          .prepare(
            `SELECT COUNT(*)::int AS total
               FROM payment_transfer_batches
              WHERE ${scope.where}`
          )
          .bind(...scope.values)
          .first<{ total: number }>(),
      ]);

      return {
        rows: rowsResult.results.map(mapPaymentTransferBatchRow),
        total: countRow?.total ?? 0,
      };
    },

    async createTransferRecipient(input: CreatePaymentTransferRecipientInput) {
      const recipientId = generatePaymentTransferRecipientId();
      const row = await db
        .prepare(
          `INSERT INTO payment_transfer_recipients (
             id,
             batch_id,
             organization_id,
             project_id,
             transfer_id,
             external_id,
             counterparty_id,
             counterparty_account_id,
             destination_address,
             amount,
             status,
             error
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           RETURNING *`
        )
        .bind(
          recipientId,
          input.batchId,
          input.organizationId,
          input.projectId,
          input.transferId ?? null,
          input.externalId ?? null,
          input.counterpartyId,
          input.counterpartyAccountId,
          input.destinationAddress,
          input.amount,
          input.status ?? "pending",
          input.error ?? null
        )
        .first<Record<string, unknown>>();

      if (!row) {
        throw internalError("payment_transfer_recipients INSERT ... RETURNING returned no row");
      }
      return mapPaymentTransferRecipientRow(row);
    },

    async upsertTransferRecipient(input: UpsertPaymentTransferRecipientInput) {
      const recipientId = input.recipientId ?? generatePaymentTransferRecipientId();
      const row = await db
        .prepare(
          `INSERT INTO payment_transfer_recipients (
             id,
             batch_id,
             organization_id,
             project_id,
             transfer_id,
             external_id,
             counterparty_id,
             counterparty_account_id,
             destination_address,
             amount,
             status,
             error
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (id) DO UPDATE SET
             batch_id = EXCLUDED.batch_id,
             transfer_id = EXCLUDED.transfer_id,
             external_id = EXCLUDED.external_id,
             counterparty_id = EXCLUDED.counterparty_id,
             counterparty_account_id = EXCLUDED.counterparty_account_id,
             destination_address = EXCLUDED.destination_address,
             amount = EXCLUDED.amount,
             status = EXCLUDED.status,
             error = EXCLUDED.error,
             updated_at = sdp_iso_now()
           WHERE payment_transfer_recipients.organization_id = EXCLUDED.organization_id
             AND payment_transfer_recipients.project_id = EXCLUDED.project_id
           RETURNING *`
        )
        .bind(
          recipientId,
          input.batchId,
          input.organizationId,
          input.projectId,
          input.transferId ?? null,
          input.externalId ?? null,
          input.counterpartyId,
          input.counterpartyAccountId,
          input.destinationAddress,
          input.amount,
          input.status ?? "pending",
          input.error ?? null
        )
        .first<Record<string, unknown>>();

      if (!row) {
        throw internalError("payment_transfer_recipients UPSERT returned no row");
      }
      return mapPaymentTransferRecipientRow(row);
    },

    async updateTransferRecipient(input: UpdatePaymentTransferRecipientInput) {
      const scope = buildScopeWhere({
        organizationId: input.organizationId,
        projectId: input.projectId,
        extraClauses: ["id = ?", "status <> 'archived'"],
        extraValues: [input.recipientId],
      });

      const row = await db
        .prepare(
          `UPDATE payment_transfer_recipients
             SET batch_id = COALESCE(?, batch_id),
                 transfer_id = CASE WHEN ?::boolean THEN ? ELSE transfer_id END,
                 external_id = CASE WHEN ?::boolean THEN ? ELSE external_id END,
                 counterparty_id = COALESCE(?, counterparty_id),
                 counterparty_account_id = COALESCE(?, counterparty_account_id),
                 destination_address = COALESCE(?, destination_address),
                 amount = COALESCE(?, amount),
                 status = COALESCE(?, status),
                 error = CASE WHEN ?::boolean THEN ? ELSE error END,
                 updated_at = sdp_iso_now()
           WHERE ${scope.where}
           RETURNING *`
        )
        .bind(
          input.batchId ?? null,
          input.transferId !== undefined,
          input.transferId ?? null,
          input.externalId !== undefined,
          input.externalId ?? null,
          input.counterpartyId ?? null,
          input.counterpartyAccountId ?? null,
          input.destinationAddress ?? null,
          input.amount ?? null,
          input.status ?? null,
          input.error !== undefined,
          input.error ?? null,
          ...scope.values
        )
        .first<Record<string, unknown>>();

      return row ? mapPaymentTransferRecipientRow(row) : null;
    },

    async updateTransferRecipientsStatus(input: UpdatePaymentTransferRecipientsStatusInput) {
      if (input.recipientIds.length === 0) {
        return [];
      }

      const scope = buildScopeWhere({
        organizationId: input.organizationId,
        projectId: input.projectId,
        extraClauses: [
          `id IN (${input.recipientIds.map(() => "?").join(", ")})`,
          input.requireUnsent === true
            ? "status = 'pending' AND transfer_id IS NULL"
            : "status <> 'archived'",
        ],
        extraValues: input.recipientIds,
      });

      const result = await db
        .prepare(
          `UPDATE payment_transfer_recipients
             SET transfer_id = ?,
                 status = ?,
                 error = ?,
                 updated_at = sdp_iso_now()
           WHERE ${scope.where}
           RETURNING *`
        )
        .bind(input.transferId, input.status, input.error, ...scope.values)
        .all<Record<string, unknown>>();

      return result.results.map(mapPaymentTransferRecipientRow);
    },

    async deleteTransferRecipient(input: DeletePaymentTransferRecipientInput) {
      const scope = buildScopeWhere({
        organizationId: input.organizationId,
        projectId: input.projectId,
        extraClauses: ["id = ?", "status <> 'archived'"],
        extraValues: [input.recipientId],
      });

      const row = await db
        .prepare(
          `UPDATE payment_transfer_recipients
              SET status = 'archived',
                  updated_at = sdp_iso_now()
            WHERE ${scope.where}
            RETURNING *`
        )
        .bind(...scope.values)
        .first<Record<string, unknown>>();

      return row ? mapPaymentTransferRecipientRow(row) : null;
    },

    async getTransferRecipientById(input: GetPaymentTransferRecipientInput) {
      return getTransferRecipientByIdInternal(db, input);
    },

    async listTransferRecipientsByBatch(
      input: ListPaymentTransferRecipientsInput
    ): Promise<ListPaymentTransferRecipientsResult> {
      const extraClauses = ["batch_id = ?"];
      const extraValues: unknown[] = [input.batchId];

      if (input.transferId) {
        extraClauses.push("transfer_id = ?");
        extraValues.push(input.transferId);
      }
      if (input.status) {
        extraClauses.push("status = ?");
        extraValues.push(input.status);
      } else {
        extraClauses.push("status <> 'archived'");
      }

      const scope = buildScopeWhere({
        organizationId: input.organizationId,
        projectId: input.projectId,
        extraClauses,
        extraValues,
      });

      const [rowsResult, countRow] = await Promise.all([
        db
          .prepare(
            `SELECT *
               FROM payment_transfer_recipients
              WHERE ${scope.where}
              ORDER BY created_at ASC, id ASC
              LIMIT ? OFFSET ?`
          )
          .bind(...scope.values, input.limit, input.offset)
          .all<Record<string, unknown>>(),
        db
          .prepare(
            `SELECT COUNT(*)::int AS total
               FROM payment_transfer_recipients
              WHERE ${scope.where}`
          )
          .bind(...scope.values)
          .first<{ total: number }>(),
      ]);

      return {
        rows: rowsResult.results.map(mapPaymentTransferRecipientRow),
        total: countRow?.total ?? 0,
      };
    },

    async settleTransferBatch(input: SettlePaymentTransferBatchInput) {
      return db.transaction(async (tx) => {
        const claimed = await tx
          .prepare(
            `UPDATE payment_transfers
                SET status = ?,
                    slot = CASE WHEN ?::boolean THEN ? ELSE slot END,
                    error = ?,
                    confirmed_at = CASE WHEN ?::boolean THEN COALESCE(confirmed_at, ?) ELSE confirmed_at END,
                    updated_at = ?
              WHERE id = ?
                AND organization_id = ?
                AND project_id IS NOT DISTINCT FROM ?
                AND (NOT ?::boolean OR (
                  signature IS NULL
                  AND signed_transaction IS NULL
                  AND submission_started_at IS NULL
                ))
                AND status = 'processing'
                AND (NOT ?::boolean OR submission_started_at IS NULL)
              RETURNING id`
          )
          .bind(
            input.transferStatus,
            input.slot !== null,
            input.slot,
            input.error,
            input.transferStatus !== "failed",
            input.updatedAt,
            input.updatedAt,
            input.transferId,
            input.organizationId,
            input.projectId,
            input.requireUnsigned === true,
            input.requireUnstarted === true
          )
          .all<{ id: string }>();

        if (claimed.results.length === 0) {
          return false;
        }

        const recipientStatus = input.transferStatus === "failed" ? "failed" : "confirmed";
        const recipients = await tx
          .prepare(
            `UPDATE payment_transfer_recipients
                SET status = ?,
                    error = ?,
                    updated_at = sdp_iso_now()
              WHERE organization_id = ?
                AND project_id = ?
                AND transfer_id = ?
                AND status = 'processing'
              RETURNING *`
          )
          .bind(
            recipientStatus,
            recipientStatus === "failed" ? input.error : null,
            input.organizationId,
            input.projectId,
            input.transferId
          )
          .all<{ batch_id: string }>();

        if (recipients.results.length === 0) {
          throw internalError("Transfer batch recipients not found for settlement");
        }

        await recomputeBatchStatusInTransaction(tx, {
          batchId: recipients.results[0].batch_id,
          organizationId: input.organizationId,
          projectId: input.projectId,
        });
        return true;
      });
    },

    async recomputeTransferBatchStatus(input: RecomputeTransferBatchStatusInput) {
      return db.transaction((tx) => recomputeBatchStatusInTransaction(tx, input));
    },

    async listStrandedTransferBatches(input) {
      const strandedCutoff = strandedRecipientCutoff(input);
      const result = await db
        .prepare(
          `SELECT b.id, b.organization_id, b.project_id
             FROM payment_transfer_batches b
             JOIN projects p ON p.id = b.project_id
            WHERE p.environment = ?
              AND b.status = 'processing'
              AND EXISTS (
                SELECT 1 FROM payment_transfer_recipients r
                 WHERE r.batch_id = b.id AND r.status = 'pending' AND r.transfer_id IS NULL
                   AND ${strandedCutoff.sql("r.")}
              )
            ORDER BY b.created_at
            LIMIT ?`
        )
        .bind(input.environment, ...strandedCutoff.values, input.limit)
        .all<{ id: string; organization_id: string; project_id: string }>();
      return result.results.map((row) => ({
        batchId: row.id,
        organizationId: row.organization_id,
        projectId: row.project_id,
      }));
    },

    async lowestUnsentAttemptBlockHeight({ environment }) {
      const row = await db
        .prepare(
          `SELECT MIN(r.attempt_last_valid_block_height)::text AS height
             FROM payment_transfer_recipients r
             JOIN payment_transfer_batches b ON b.id = r.batch_id
             JOIN projects p ON p.id = b.project_id
            WHERE p.environment = ?
              AND b.status = 'processing'
              AND r.status = 'pending'
              AND r.transfer_id IS NULL
              AND r.attempt_last_valid_block_height IS NOT NULL`
        )
        .bind(environment)
        .first<{ height: string | null }>();
      return row?.height == null ? null : BigInt(row.height);
    },

    async listSupersededTransferIds({ batchId, organizationId, projectId }) {
      const result = await db
        .prepare(
          `SELECT superseded_transfer_ids FROM payment_transfer_batch_retries
            WHERE batch_id = ? AND organization_id = ? AND project_id = ? AND status = 'active'
            ORDER BY created_at`
        )
        .bind(batchId, organizationId, projectId)
        .all<{ superseded_transfer_ids: unknown }>();
      return result.results.flatMap((row) =>
        idListSchema.parse(parsePostgresJson<unknown>(row.superseded_transfer_ids))
      );
    },

    async findTransferBatchRetryByIdempotency({ organizationId, projectId, idempotencyKey }) {
      const row = await db
        .prepare(
          `SELECT * FROM payment_transfer_batch_retries
            WHERE organization_id = ? AND project_id = ? AND idempotency_key = ?
              AND status = 'active'`
        )
        .bind(organizationId, projectId, idempotencyKey)
        .first<Record<string, unknown>>();
      return row ? mapPaymentTransferBatchRetryRow(row) : null;
    },

    async failUnsentTransferRecipients(input) {
      const strandedCutoff = strandedRecipientCutoff(input);
      return db.transaction(async (tx) => {
        // The batch lock first, as every batch status writer takes it.
        await tx
          .prepare(
            `SELECT id FROM payment_transfer_batches
              WHERE id = ? AND organization_id = ? AND project_id = ?
              FOR UPDATE`
          )
          .bind(input.batchId, input.organizationId, input.projectId)
          .first<{ id: string }>();
        await tx
          .prepare(
            `UPDATE payment_transfer_recipients
                SET status = 'failed', error = ?, updated_at = sdp_iso_now()
              WHERE batch_id = ?
                AND organization_id = ?
                AND project_id = ?
                AND status = 'pending'
                AND transfer_id IS NULL
                AND ${strandedCutoff.sql("")}
                ${recipientIdClause(input.recipientIds)}`
          )
          .bind(
            input.error,
            input.batchId,
            input.organizationId,
            input.projectId,
            ...strandedCutoff.values,
            ...(input.recipientIds ?? [])
          )
          .run();
        return recomputeBatchStatusInTransaction(tx, input);
      });
    },

    async claimFailedTransferRecipients(input: ClaimFailedTransferRecipientsInput) {
      if (input.recipientIds.length === 0) return null;
      return db
        .transaction(async (tx) => {
          // The batch lock first, as every batch status writer takes it.
          const batch = await tx
            .prepare(
              `UPDATE payment_transfer_batches
                SET transaction_count = transaction_count + ?,
                    updated_at = sdp_iso_now()
              WHERE id = ? AND organization_id = ? AND project_id = ?
                AND status <> 'archived'
              RETURNING id`
            )
            .bind(input.addedTransactionCount, input.batchId, input.organizationId, input.projectId)
            .first<{ id: string }>();
          if (!batch) return null;
          const claimed = await tx
            .prepare(
              `UPDATE payment_transfer_recipients r
                SET status = 'pending', transfer_id = NULL, error = NULL, updated_at = sdp_iso_now(),
                    attempt_last_valid_block_height = ?
               FROM (
                 SELECT id, transfer_id FROM payment_transfer_recipients
                  WHERE batch_id = ?
                    AND organization_id = ?
                    AND project_id = ?
                    AND status = 'failed'
                    AND id IN (${input.recipientIds.map(() => "?").join(", ")})
                  FOR UPDATE
               ) previous
              WHERE r.id = previous.id
              RETURNING r.*, previous.transfer_id AS superseded_transfer_id`
            )
            .bind(
              input.attemptLastValidBlockHeight.toString(),
              input.batchId,
              input.organizationId,
              input.projectId,
              ...input.recipientIds
            )
            .all<Record<string, unknown>>();
          if (claimed.results.length !== input.recipientIds.length) {
            throw new ClaimLostError();
          }
          const supersededTransferIds = [
            ...new Set(
              claimed.results.flatMap((row) =>
                typeof row.superseded_transfer_id === "string" ? [row.superseded_transfer_id] : []
              )
            ),
          ];
          const retry = await tx
            .prepare(
              `INSERT INTO payment_transfer_batch_retries
                 (id, batch_id, organization_id, project_id, idempotency_key,
                  idempotency_fingerprint, initiated_by_key_id, recipient_ids,
                  superseded_transfer_ids)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?::jsonb)
               RETURNING *`
            )
            .bind(
              generatePaymentTransferBatchRetryId(),
              input.batchId,
              input.organizationId,
              input.projectId,
              input.retry.idempotencyKey,
              input.retry.idempotencyFingerprint,
              input.retry.initiatedByKeyId,
              JSON.stringify(input.recipientIds),
              JSON.stringify(supersededTransferIds)
            )
            .first<Record<string, unknown>>();
          if (!retry) throw internalError("Transfer batch retry was not recorded");
          return {
            batch: await recomputeBatchStatusInTransaction(tx, input),
            recipients: claimed.results.map(mapPaymentTransferRecipientRow),
            retry: mapPaymentTransferBatchRetryRow(retry),
          };
        })
        .catch((error: unknown) => {
          if (error instanceof ClaimLostError) return null;
          throw error;
        });
    },
  };
}

const idListSchema = z.array(z.string());

function mapPaymentTransferBatchRetryRow(
  row: Record<string, unknown>
): PaymentTransferBatchRetryRow {
  return {
    id: String(row.id),
    batch_id: String(row.batch_id),
    idempotency_fingerprint: String(row.idempotency_fingerprint),
    initiated_by_key_id: row.initiated_by_key_id === null ? null : String(row.initiated_by_key_id),
    recipient_ids: idListSchema.parse(parsePostgresJson<unknown>(row.recipient_ids)),
    superseded_transfer_ids: idListSchema.parse(
      parsePostgresJson<unknown>(row.superseded_transfer_ids)
    ),
    created_at: String(row.created_at),
  };
}

/**
 * The SQL test for a stranded unsent recipient: written before an instant, or
 * written by an attempt whose lastValidBlockHeight the chain has passed.
 */
function strandedRecipientCutoff(cutoff: StrandedRecipientCutoff): {
  sql: (alias: string) => string;
  values: string[];
} {
  const tests: string[] = [];
  const values: string[] = [];
  if (cutoff.attemptedBefore !== undefined) {
    tests.push("{a}updated_at < ?");
    values.push(cutoff.attemptedBefore);
  }
  if (cutoff.expiredBelowBlockHeight !== undefined) {
    tests.push(
      "({a}attempt_last_valid_block_height IS NOT NULL AND {a}attempt_last_valid_block_height < ?)"
    );
    values.push(cutoff.expiredBelowBlockHeight.toString());
  }
  return { sql: (alias) => `(${tests.join(" OR ").replaceAll("{a}", alias)})`, values };
}

/** Limits a recipient update to the named ids; none named matches none. */
function recipientIdClause(recipientIds: string[] | undefined): string {
  if (recipientIds === undefined) return "";
  if (recipientIds.length === 0) return "AND FALSE";
  return `AND id IN (${recipientIds.map(() => "?").join(", ")})`;
}

/** Rolls a partial claim back: another resend took one of the recipients. */
class ClaimLostError extends Error {}

/**
 * Locks the batch row, derives the batch status from its recipient rows, and
 * writes it — inside the caller's transaction. Taking the lock before the
 * scan serializes concurrent recomputes of one batch, so each scan observes
 * the previous writer's committed recipient statuses.
 *
 * @param tx - Transaction executor the recompute runs in.
 * @param input.batchId - Batch to recompute.
 * @returns The batch row after the recompute.
 */
async function recomputeBatchStatusInTransaction(
  tx: DatabaseExecutor,
  input: RecomputeTransferBatchStatusInput
): Promise<PaymentTransferBatchRow> {
  const locked = await tx
    .prepare(
      `SELECT id
         FROM payment_transfer_batches
        WHERE id = ?
          AND organization_id = ?
          AND project_id = ?
          FOR UPDATE`
    )
    .bind(input.batchId, input.organizationId, input.projectId)
    .first<{ id: string }>();
  if (!locked) {
    throw internalError("Transfer batch not found for settlement");
  }

  const statusRows = await tx
    .prepare(
      `SELECT status
         FROM payment_transfer_recipients
        WHERE batch_id = ?
          AND organization_id = ?
          AND project_id = ?
          AND status <> 'archived'`
    )
    .bind(input.batchId, input.organizationId, input.projectId)
    .all<{ status: PaymentTransferRecipientRow["status"] }>();
  const batchStatus = deriveTransferBatchStatus(statusRows.results.map((row) => row.status));
  const batchError =
    batchStatus === "failed" || batchStatus === "partially_failed"
      ? "One or more transfer batch transactions failed during execution"
      : null;

  const updated = await tx
    .prepare(
      `UPDATE payment_transfer_batches
          SET status = ?,
              error = ?,
              updated_at = sdp_iso_now()
        WHERE id = ?
          AND organization_id = ?
          AND project_id = ?
          AND status <> 'archived'
        RETURNING *`
    )
    .bind(batchStatus, batchError, input.batchId, input.organizationId, input.projectId)
    .first<Record<string, unknown>>();
  if (!updated) {
    throw internalError("Transfer batch not found for settlement");
  }

  return mapPaymentTransferBatchRow(updated);
}
