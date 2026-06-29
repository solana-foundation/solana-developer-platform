import type { DatabaseExecutor } from "@/db";
import { internalError } from "@/lib/errors";
import type {
  CreatePaymentTransferBatchInput,
  CreatePaymentTransferRecipientInput,
  DeletePaymentTransferBatchInput,
  DeletePaymentTransferRecipientInput,
  GetPaymentTransferBatchInput,
  GetPaymentTransferRecipientInput,
  ListPaymentTransferBatchesInput,
  ListPaymentTransferBatchesResult,
  ListPaymentTransferRecipientsInput,
  ListPaymentTransferRecipientsResult,
  PaymentTransferBatchesRepository,
  PaymentTransferBatchRow,
  PaymentTransferRecipientRow,
  UpdatePaymentTransferBatchInput,
  UpdatePaymentTransferRecipientInput,
  UpsertPaymentTransferBatchInput,
  UpsertPaymentTransferRecipientInput,
} from "./payment-transfer-batches.repository";
import {
  generatePaymentTransferBatchId,
  generatePaymentTransferRecipientId,
} from "./payment-transfer-batches.repository";

function mapPaymentTransferBatchRow(row: Record<string, unknown>): PaymentTransferBatchRow {
  return {
    id: row.id as string,
    organization_id: row.organization_id as string,
    project_id: row.project_id as string,
    external_id: (row.external_id as string | null | undefined) ?? null,
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

export function createPostgresPaymentTransferBatchesRepository(
  db: DatabaseExecutor
): PaymentTransferBatchesRepository {
  return {
    async createTransferBatch(input: CreatePaymentTransferBatchInput) {
      const batchId = generatePaymentTransferBatchId();
      const row = await db
        .prepare(
          `INSERT INTO payment_transfer_batches (
             id,
             organization_id,
             project_id,
             external_id,
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
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?::jsonb, '{}'::jsonb), ?, ?)
           RETURNING *`
        )
        .bind(
          batchId,
          input.organizationId,
          input.projectId,
          input.externalId ?? null,
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
        throw internalError("payment_transfer_batches INSERT ... RETURNING returned no row");
      }
      return mapPaymentTransferBatchRow(row);
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
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?::jsonb, '{}'::jsonb), ?, ?)
           ON CONFLICT (id) DO UPDATE SET
             external_id = EXCLUDED.external_id,
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
              ORDER BY created_at ASC
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
  };
}
