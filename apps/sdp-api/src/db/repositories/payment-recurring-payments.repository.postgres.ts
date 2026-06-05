import type { DatabaseExecutor } from "@/db";
import type {
  CreatePaymentRecurringPaymentInput,
  ListDuePaymentRecurringPaymentsInput,
  ListPaymentRecurringPaymentsInput,
  ListPaymentRecurringPaymentsResult,
  PaymentRecurringPaymentRow,
  PaymentRecurringPaymentsRepository,
  UpdatePaymentRecurringPaymentInput,
} from "./payment-recurring-payments.repository";

function buildInClause(length: number): string {
  return Array.from({ length }, () => "?").join(", ");
}

function mapRecurringPaymentRow(row: Record<string, unknown>): PaymentRecurringPaymentRow {
  return {
    id: row.id as string,
    organization_id: row.organization_id as string,
    project_id: row.project_id as string,
    source_wallet_id: row.source_wallet_id as string,
    source_address: row.source_address as string,
    counterparty_id: row.counterparty_id as string,
    counterparty_account_id: row.counterparty_account_id as string,
    destination_address: row.destination_address as string,
    destination_token_account: (row.destination_token_account as string | null | undefined) ?? null,
    token: row.token as string,
    amount: row.amount as string,
    period_hours: row.period_hours as number,
    first_collection_at: (row.first_collection_at as string | null | undefined) ?? null,
    next_collection_due_at: (row.next_collection_due_at as string | null | undefined) ?? null,
    plan_id: (row.plan_id as string | null | undefined) ?? null,
    subscription_id: (row.subscription_id as string | null | undefined) ?? null,
    plan_pda: (row.plan_pda as string | null | undefined) ?? null,
    plan_created_at: (row.plan_created_at as string | null | undefined) ?? null,
    plan_creation_signature: (row.plan_creation_signature as string | null | undefined) ?? null,
    subscription_pda: (row.subscription_pda as string | null | undefined) ?? null,
    subscription_authority_address:
      (row.subscription_authority_address as string | null | undefined) ?? null,
    authorization_signature: (row.authorization_signature as string | null | undefined) ?? null,
    status: row.status as PaymentRecurringPaymentRow["status"],
    metadata_uri: (row.metadata_uri as string | null | undefined) ?? null,
    created_by: (row.created_by as string | null | undefined) ?? null,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

async function getRecurringPaymentByIdInternal(
  db: DatabaseExecutor,
  recurringPaymentId: string
): Promise<PaymentRecurringPaymentRow | null> {
  const row = await db
    .prepare("SELECT * FROM payment_recurring_payments WHERE id = ?")
    .bind(recurringPaymentId)
    .first<Record<string, unknown>>();

  return row ? mapRecurringPaymentRow(row) : null;
}

export function createPostgresPaymentRecurringPaymentsRepository(
  db: DatabaseExecutor
): PaymentRecurringPaymentsRepository {
  return {
    async createRecurringPayment(input: CreatePaymentRecurringPaymentInput) {
      await db
        .prepare(
          `INSERT INTO payment_recurring_payments (
             id,
             organization_id,
             project_id,
             source_wallet_id,
             source_address,
             counterparty_id,
             counterparty_account_id,
             destination_address,
             token,
             amount,
             period_hours,
             first_collection_at,
             metadata_uri,
             created_by,
             created_at,
             updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          input.id,
          input.organizationId,
          input.projectId,
          input.sourceWalletId,
          input.sourceAddress,
          input.counterpartyId,
          input.counterpartyAccountId,
          input.destinationAddress,
          input.token,
          input.amount,
          input.periodHours,
          input.firstCollectionAt,
          input.metadataUri,
          input.createdBy,
          input.createdAt,
          input.updatedAt
        )
        .run();

      return getRecurringPaymentByIdInternal(db, input.id);
    },

    async updateRecurringPayment(input: UpdatePaymentRecurringPaymentInput) {
      const whereClauses = ["id = ?", "organization_id = ?", "project_id = ?"];
      const whereValues: unknown[] = [
        input.recurringPaymentId,
        input.organizationId,
        input.projectId,
      ];

      if (input.expectedStatus !== undefined) {
        whereClauses.push("status = ?");
        whereValues.push(input.expectedStatus);
      }
      if (input.expectedNextCollectionDueAt !== undefined) {
        if (input.expectedNextCollectionDueAt === null) {
          whereClauses.push("next_collection_due_at IS NULL");
        } else {
          whereClauses.push("next_collection_due_at = ?");
          whereValues.push(input.expectedNextCollectionDueAt);
        }
      }

      const changes = await db
        .prepare(
          `UPDATE payment_recurring_payments
              SET destination_token_account =
                    CASE WHEN ?::boolean THEN ? ELSE destination_token_account END,
                  next_collection_due_at =
                    CASE WHEN ?::boolean THEN ? ELSE next_collection_due_at END,
                  plan_id = CASE WHEN ?::boolean THEN ? ELSE plan_id END,
                  subscription_id = CASE WHEN ?::boolean THEN ? ELSE subscription_id END,
                  plan_pda = CASE WHEN ?::boolean THEN ? ELSE plan_pda END,
                  plan_created_at = CASE WHEN ?::boolean THEN ? ELSE plan_created_at END,
                  plan_creation_signature =
                    CASE WHEN ?::boolean THEN ? ELSE plan_creation_signature END,
                  subscription_pda = CASE WHEN ?::boolean THEN ? ELSE subscription_pda END,
                  subscription_authority_address =
                    CASE WHEN ?::boolean THEN ? ELSE subscription_authority_address END,
                  authorization_signature =
                    CASE WHEN ?::boolean THEN ? ELSE authorization_signature END,
                  status = COALESCE(?, status),
                  updated_at = ?
            WHERE ${whereClauses.join(" AND ")}`
        )
        .bind(
          input.destinationTokenAccount !== undefined,
          input.destinationTokenAccount ?? null,
          input.nextCollectionDueAt !== undefined,
          input.nextCollectionDueAt ?? null,
          input.planId !== undefined,
          input.planId ?? null,
          input.subscriptionId !== undefined,
          input.subscriptionId ?? null,
          input.planPda !== undefined,
          input.planPda ?? null,
          input.planCreatedAt !== undefined,
          input.planCreatedAt ?? null,
          input.planCreationSignature !== undefined,
          input.planCreationSignature ?? null,
          input.subscriptionPda !== undefined,
          input.subscriptionPda ?? null,
          input.subscriptionAuthorityAddress !== undefined,
          input.subscriptionAuthorityAddress ?? null,
          input.authorizationSignature !== undefined,
          input.authorizationSignature ?? null,
          input.status ?? null,
          input.updatedAt,
          ...whereValues
        )
        .run();

      if (changes === 0) {
        return null;
      }

      return getRecurringPaymentByIdInternal(db, input.recurringPaymentId);
    },

    async getRecurringPaymentById(params) {
      const row = await db
        .prepare(
          `SELECT *
             FROM payment_recurring_payments
            WHERE id = ?
              AND organization_id = ?
              AND project_id = ?`
        )
        .bind(params.recurringPaymentId, params.organizationId, params.projectId)
        .first<Record<string, unknown>>();

      return row ? mapRecurringPaymentRow(row) : null;
    },

    async getActiveRecurringPaymentBySubscriptionId(params) {
      const row = await db
        .prepare(
          `SELECT *
             FROM payment_recurring_payments
            WHERE subscription_id = ?
              AND organization_id = ?
              AND project_id = ?
              AND status = 'active'
            LIMIT 1`
        )
        .bind(params.subscriptionId, params.organizationId, params.projectId)
        .first<Record<string, unknown>>();

      return row ? mapRecurringPaymentRow(row) : null;
    },

    async listRecurringPayments(params: ListPaymentRecurringPaymentsInput) {
      const clauses = ["organization_id = ?", "project_id = ?"];
      const values: unknown[] = [params.organizationId, params.projectId];

      if (params.status) {
        clauses.push("status = ?");
        values.push(params.status);
      }
      if (params.counterpartyId) {
        clauses.push("counterparty_id = ?");
        values.push(params.counterpartyId);
      }
      if (params.sourceWalletIds?.length) {
        clauses.push(`source_wallet_id IN (${buildInClause(params.sourceWalletIds.length)})`);
        values.push(...params.sourceWalletIds);
      }

      const whereClause = clauses.join(" AND ");
      const [rows, countRow] = await Promise.all([
        db
          .prepare(
            `SELECT *
               FROM payment_recurring_payments
              WHERE ${whereClause}
              ORDER BY created_at DESC
              LIMIT ? OFFSET ?`
          )
          .bind(...values, params.limit, params.offset)
          .all<Record<string, unknown>>(),
        db
          .prepare(
            `SELECT COUNT(*)::int AS total
               FROM payment_recurring_payments
              WHERE ${whereClause}`
          )
          .bind(...values)
          .first<{ total: number }>(),
      ]);

      return {
        rows: rows.results.map(mapRecurringPaymentRow),
        total: countRow?.total ?? 0,
      } satisfies ListPaymentRecurringPaymentsResult;
    },

    async listDueRecurringPayments(params: ListDuePaymentRecurringPaymentsInput) {
      const rows = await db
        .prepare(
          `SELECT rp.*
             FROM payment_recurring_payments rp
            WHERE rp.status = 'active'
              AND rp.next_collection_due_at IS NOT NULL
              AND rp.next_collection_due_at <= ?
              AND NOT EXISTS (
                    SELECT 1
                      FROM payment_subscription_collection_attempts a
                     WHERE a.recurring_payment_id = rp.id
                       AND a.due_at = rp.next_collection_due_at
                       AND a.status IN ('pending', 'processing', 'confirmed')
                       AND NOT (
                         a.status = 'processing'
                         AND a.signature IS NULL
                         AND a.updated_at <= ?
                       )
                       AND NOT (
                         a.status IN ('processing', 'confirmed')
                         AND a.transfer_id IS NOT NULL
                         AND a.signature IS NOT NULL
                       )
                  )
              AND (
                    EXISTS (
                      SELECT 1
                        FROM payment_subscription_collection_attempts submitted
                       WHERE submitted.recurring_payment_id = rp.id
                         AND submitted.due_at = rp.next_collection_due_at
                         AND submitted.status IN ('processing', 'confirmed')
                         AND submitted.transfer_id IS NOT NULL
                         AND submitted.signature IS NOT NULL
                    )
                    OR NOT EXISTS (
                      SELECT 1
                        FROM payment_subscription_collection_attempts retry
                       WHERE retry.recurring_payment_id = rp.id
                         AND retry.due_at = rp.next_collection_due_at
                         AND retry.status = 'failed'
                         AND retry.updated_at > ?
                    )
                  )
            ORDER BY rp.next_collection_due_at ASC
            LIMIT ?`
        )
        .bind(params.now, params.retryAfter, params.retryAfter, params.limit)
        .all<Record<string, unknown>>();

      return rows.results.map(mapRecurringPaymentRow);
    },
  };
}
