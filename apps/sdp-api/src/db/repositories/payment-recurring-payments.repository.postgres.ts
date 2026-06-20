import type { DatabaseExecutor } from "@/db";
import type {
  CreatePaymentRecurringPaymentInput,
  ListPaymentRecurringPaymentsInput,
  ListPaymentRecurringPaymentsResult,
  PaymentRecurringPaymentRow,
  PaymentRecurringPaymentsRepository,
  UpdatePaymentRecurringPaymentActivationInput,
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
  params: { recurringPaymentId: string; organizationId: string; projectId: string }
): Promise<PaymentRecurringPaymentRow | null> {
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

      return getRecurringPaymentByIdInternal(db, {
        recurringPaymentId: input.id,
        organizationId: input.organizationId,
        projectId: input.projectId,
      });
    },

    async claimRecurringPaymentActivation(params) {
      const row = await db
        .prepare(
          `UPDATE payment_recurring_payments
              SET status = 'activating',
                  updated_at = ?
            WHERE id = ?
              AND organization_id = ?
              AND project_id = ?
              AND status = 'pending_activation'
          RETURNING *`
        )
        .bind(params.updatedAt, params.recurringPaymentId, params.organizationId, params.projectId)
        .first<Record<string, unknown>>();

      return row ? mapRecurringPaymentRow(row) : null;
    },

    async resetRecurringPaymentActivationIfNotActive(params) {
      const row = await db
        .prepare(
          `UPDATE payment_recurring_payments
              SET status = 'pending_activation',
                  updated_at = ?
            WHERE id = ?
              AND organization_id = ?
              AND project_id = ?
              AND status = 'activating'
          RETURNING *`
        )
        .bind(params.updatedAt, params.recurringPaymentId, params.organizationId, params.projectId)
        .first<Record<string, unknown>>();

      return row ? mapRecurringPaymentRow(row) : null;
    },

    async updateRecurringPaymentActivation(input: UpdatePaymentRecurringPaymentActivationInput) {
      const allowActiveUpdate = input.status === "active";
      const row = await db
        .prepare(
          `UPDATE payment_recurring_payments
              SET status = COALESCE(?, status),
                  plan_id = CASE WHEN ?::boolean THEN ? ELSE plan_id END,
                  subscription_id = CASE WHEN ?::boolean THEN ? ELSE subscription_id END,
                  plan_pda = CASE WHEN ?::boolean THEN ? ELSE plan_pda END,
                  plan_created_at = CASE WHEN ?::boolean THEN ? ELSE plan_created_at END,
                  plan_creation_signature =
                    CASE WHEN ?::boolean THEN ? ELSE plan_creation_signature END,
                  subscription_pda =
                    CASE WHEN ?::boolean THEN ? ELSE subscription_pda END,
                  subscription_authority_address =
                    CASE WHEN ?::boolean THEN ? ELSE subscription_authority_address END,
                  authorization_signature =
                    CASE WHEN ?::boolean THEN ? ELSE authorization_signature END,
                  next_collection_due_at =
                    CASE WHEN ?::boolean THEN ? ELSE next_collection_due_at END,
                  destination_token_account =
                    CASE WHEN ?::boolean THEN ? ELSE destination_token_account END,
                  updated_at = ?
            WHERE id = ?
              AND organization_id = ?
              AND project_id = ?
              AND (status = 'activating' OR ?::boolean)
          RETURNING *`
        )
        .bind(
          input.status ?? null,
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
          input.nextCollectionDueAt !== undefined,
          input.nextCollectionDueAt ?? null,
          input.destinationTokenAccount !== undefined,
          input.destinationTokenAccount ?? null,
          input.updatedAt,
          input.recurringPaymentId,
          input.organizationId,
          input.projectId,
          allowActiveUpdate
        )
        .first<Record<string, unknown>>();

      return row ? mapRecurringPaymentRow(row) : null;
    },

    async getRecurringPaymentById(params) {
      if (params.sourceWalletIds?.length === 0) {
        return null;
      }

      const clauses = ["id = ?", "organization_id = ?", "project_id = ?"];
      const values: unknown[] = [
        params.recurringPaymentId,
        params.organizationId,
        params.projectId,
      ];

      if (params.sourceWalletIds?.length) {
        clauses.push(`source_wallet_id IN (${buildInClause(params.sourceWalletIds.length)})`);
        values.push(...params.sourceWalletIds);
      }

      const row = await db
        .prepare(
          `SELECT *
             FROM payment_recurring_payments
            WHERE ${clauses.join(" AND ")}`
        )
        .bind(...values)
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
  };
}
