import type { DatabaseExecutor } from "@/db";
import type {
  CreatePaymentRecurringPaymentActivationAttemptInput,
  CreatePaymentRecurringPaymentInput,
  ListPaymentRecurringPaymentsInput,
  ListPaymentRecurringPaymentsResult,
  PaymentRecurringPaymentActivationAttemptRow,
  PaymentRecurringPaymentRow,
  PaymentRecurringPaymentsRepository,
  UpdatePaymentRecurringPaymentActivationAttemptInput,
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

function parseMetadata(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }

  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function mapActivationAttemptRow(
  row: Record<string, unknown>
): PaymentRecurringPaymentActivationAttemptRow {
  return {
    id: row.id as string,
    organization_id: row.organization_id as string,
    project_id: row.project_id as string,
    recurring_payment_id: row.recurring_payment_id as string,
    plan_id: (row.plan_id as string | null | undefined) ?? null,
    subscription_id: (row.subscription_id as string | null | undefined) ?? null,
    status: row.status as PaymentRecurringPaymentActivationAttemptRow["status"],
    phase: row.phase as PaymentRecurringPaymentActivationAttemptRow["phase"],
    plan_creation_signature: (row.plan_creation_signature as string | null | undefined) ?? null,
    authorization_signature: (row.authorization_signature as string | null | undefined) ?? null,
    error: (row.error as string | null | undefined) ?? null,
    metadata: parseMetadata(row.metadata),
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

async function getActivationAttemptByIdInternal(
  db: DatabaseExecutor,
  params: { attemptId: string; organizationId: string; projectId: string }
): Promise<PaymentRecurringPaymentActivationAttemptRow | null> {
  const row = await db
    .prepare(
      `SELECT *
         FROM payment_recurring_payment_activation_attempts
        WHERE id = ?
          AND organization_id = ?
          AND project_id = ?`
    )
    .bind(params.attemptId, params.organizationId, params.projectId)
    .first<Record<string, unknown>>();

  return row ? mapActivationAttemptRow(row) : null;
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
      let reclaimClause = "";
      const reclaimValues: unknown[] = [];
      let freshAttemptClause = "";
      const freshAttemptValues: unknown[] = [];

      if (params.staleBefore) {
        reclaimClause = " OR (status = 'activating' AND updated_at < ?)";
        reclaimValues.push(params.staleBefore);
        freshAttemptClause = `AND NOT EXISTS (
                SELECT 1
                  FROM payment_recurring_payment_activation_attempts attempts
                 WHERE attempts.recurring_payment_id = payment_recurring_payments.id
                   AND attempts.organization_id = payment_recurring_payments.organization_id
                   AND attempts.project_id = payment_recurring_payments.project_id
                   AND attempts.status = 'processing'
                   AND attempts.updated_at >= ?
              )`;
        freshAttemptValues.push(params.staleBefore);
      } else {
        freshAttemptClause = `AND NOT EXISTS (
                SELECT 1
                  FROM payment_recurring_payment_activation_attempts attempts
                 WHERE attempts.recurring_payment_id = payment_recurring_payments.id
                   AND attempts.organization_id = payment_recurring_payments.organization_id
                   AND attempts.project_id = payment_recurring_payments.project_id
                   AND attempts.status = 'processing'
              )`;
      }

      const row = await db
        .prepare(
          `UPDATE payment_recurring_payments
              SET status = 'activating',
                  updated_at = ?
            WHERE id = ?
              AND organization_id = ?
              AND project_id = ?
              AND (status = 'pending_activation'${reclaimClause})
              ${freshAttemptClause}
          RETURNING *`
        )
        .bind(
          params.updatedAt,
          params.recurringPaymentId,
          params.organizationId,
          params.projectId,
          ...reclaimValues,
          ...freshAttemptValues
        )
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
              AND status <> 'active'
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
              AND (status <> 'active' OR ?::boolean)
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

    async createActivationAttempt(input: CreatePaymentRecurringPaymentActivationAttemptInput) {
      await db
        .prepare(
          `INSERT INTO payment_recurring_payment_activation_attempts (
             id,
             organization_id,
             project_id,
             recurring_payment_id,
             plan_id,
             subscription_id,
             status,
             phase,
             plan_creation_signature,
             authorization_signature,
             error,
             metadata,
             created_at,
             updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (recurring_payment_id) WHERE status = 'processing' DO NOTHING`
        )
        .bind(
          input.id,
          input.organizationId,
          input.projectId,
          input.recurringPaymentId,
          input.planId,
          input.subscriptionId,
          input.status,
          input.phase,
          input.planCreationSignature,
          input.authorizationSignature,
          input.error,
          JSON.stringify(input.metadata),
          input.createdAt,
          input.updatedAt
        )
        .run();

      return getActivationAttemptByIdInternal(db, {
        attemptId: input.id,
        organizationId: input.organizationId,
        projectId: input.projectId,
      });
    },

    async updateActivationAttempt(input: UpdatePaymentRecurringPaymentActivationAttemptInput) {
      const row = await db
        .prepare(
          `UPDATE payment_recurring_payment_activation_attempts
              SET plan_id = CASE WHEN ?::boolean THEN ? ELSE plan_id END,
                  subscription_id = CASE WHEN ?::boolean THEN ? ELSE subscription_id END,
                  status = COALESCE(?, status),
                  phase = COALESCE(?, phase),
                  plan_creation_signature =
                    CASE WHEN ?::boolean THEN ? ELSE plan_creation_signature END,
                  authorization_signature =
                    CASE WHEN ?::boolean THEN ? ELSE authorization_signature END,
                  error = CASE WHEN ?::boolean THEN ? ELSE error END,
                  metadata = CASE WHEN ?::boolean THEN ?::jsonb ELSE metadata END,
                  updated_at = ?
            WHERE id = ?
              AND organization_id = ?
              AND project_id = ?
          RETURNING *`
        )
        .bind(
          input.planId !== undefined,
          input.planId ?? null,
          input.subscriptionId !== undefined,
          input.subscriptionId ?? null,
          input.status ?? null,
          input.phase ?? null,
          input.planCreationSignature !== undefined,
          input.planCreationSignature ?? null,
          input.authorizationSignature !== undefined,
          input.authorizationSignature ?? null,
          input.error !== undefined,
          input.error ?? null,
          input.metadata !== undefined,
          input.metadata ? JSON.stringify(input.metadata) : null,
          input.updatedAt,
          input.attemptId,
          input.organizationId,
          input.projectId
        )
        .first<Record<string, unknown>>();

      return row ? mapActivationAttemptRow(row) : null;
    },

    async getLatestActivationAttempt(params) {
      const row = await db
        .prepare(
          `SELECT *
             FROM payment_recurring_payment_activation_attempts
            WHERE recurring_payment_id = ?
              AND organization_id = ?
              AND project_id = ?
            ORDER BY created_at DESC
            LIMIT 1`
        )
        .bind(params.recurringPaymentId, params.organizationId, params.projectId)
        .first<Record<string, unknown>>();

      return row ? mapActivationAttemptRow(row) : null;
    },
  };
}
