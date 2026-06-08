import type { DatabaseExecutor } from "@/db";
import type {
  CreatePaymentSubscriptionCollectionAttemptInput,
  CreatePaymentSubscriptionInput,
  CreatePaymentSubscriptionPlanInput,
  ListPaymentSubscriptionCollectionAttemptsInput,
  ListPaymentSubscriptionCollectionAttemptsResult,
  ListPaymentSubscriptionPlansInput,
  ListPaymentSubscriptionPlansResult,
  ListPaymentSubscriptionsInput,
  ListPaymentSubscriptionsResult,
  PaymentSubscriptionCollectionAttemptRow,
  PaymentSubscriptionPlanRow,
  PaymentSubscriptionRow,
  PaymentSubscriptionsRepository,
  UpdatePaymentSubscriptionCollectionAttemptInput,
  UpdatePaymentSubscriptionInput,
  UpdatePaymentSubscriptionPlanInput,
} from "./payment-subscriptions.repository";

type ExpireStaleUnsignedProcessingAttemptsInput = Parameters<
  PaymentSubscriptionsRepository["expireStaleUnsignedProcessingAttempts"]
>[0];

type TransactionalDatabaseExecutor = DatabaseExecutor & {
  transaction<T>(callback: (tx: DatabaseExecutor) => Promise<T>): Promise<T>;
};

function buildInClause(length: number): string {
  return Array.from({ length }, () => "?").join(", ");
}

function isTransactionalDatabaseExecutor(
  db: DatabaseExecutor
): db is TransactionalDatabaseExecutor {
  return "transaction" in db && typeof db.transaction === "function";
}

function mapPlanRow(row: Record<string, unknown>): PaymentSubscriptionPlanRow {
  return {
    id: row.id as string,
    organization_id: row.organization_id as string,
    project_id: row.project_id as string,
    owner_wallet_id: row.owner_wallet_id as string,
    owner_address: row.owner_address as string,
    token: row.token as string,
    amount: row.amount as string,
    period_hours: row.period_hours as number,
    program_plan_id: row.program_plan_id as string,
    plan_pda: (row.plan_pda as string | null | undefined) ?? null,
    destination_address: (row.destination_address as string | null | undefined) ?? null,
    puller_wallet_id: (row.puller_wallet_id as string | null | undefined) ?? null,
    puller_address: (row.puller_address as string | null | undefined) ?? null,
    metadata_uri: (row.metadata_uri as string | null | undefined) ?? null,
    status: row.status as PaymentSubscriptionPlanRow["status"],
    created_by: (row.created_by as string | null | undefined) ?? null,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

function mapSubscriptionRow(row: Record<string, unknown>): PaymentSubscriptionRow {
  return {
    id: row.id as string,
    organization_id: row.organization_id as string,
    project_id: row.project_id as string,
    plan_id: row.plan_id as string,
    counterparty_id: row.counterparty_id as string,
    subscriber_address: row.subscriber_address as string,
    subscriber_token_account: (row.subscriber_token_account as string | null | undefined) ?? null,
    subscription_pda: (row.subscription_pda as string | null | undefined) ?? null,
    subscription_authority_address:
      (row.subscription_authority_address as string | null | undefined) ?? null,
    authorization_signature: (row.authorization_signature as string | null | undefined) ?? null,
    status: row.status as PaymentSubscriptionRow["status"],
    current_period_start_at: (row.current_period_start_at as string | null | undefined) ?? null,
    next_collection_due_at: (row.next_collection_due_at as string | null | undefined) ?? null,
    cancel_at: (row.cancel_at as string | null | undefined) ?? null,
    canceled_at: (row.canceled_at as string | null | undefined) ?? null,
    created_by: (row.created_by as string | null | undefined) ?? null,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

function mapAttemptRow(row: Record<string, unknown>): PaymentSubscriptionCollectionAttemptRow {
  return {
    id: row.id as string,
    organization_id: row.organization_id as string,
    project_id: row.project_id as string,
    subscription_id: row.subscription_id as string,
    recurring_payment_id: (row.recurring_payment_id as string | null | undefined) ?? null,
    transfer_id: (row.transfer_id as string | null | undefined) ?? null,
    token: row.token as string,
    amount: row.amount as string,
    due_at: row.due_at as string,
    attempted_at: (row.attempted_at as string | null | undefined) ?? null,
    status: row.status as PaymentSubscriptionCollectionAttemptRow["status"],
    signature: (row.signature as string | null | undefined) ?? null,
    error: (row.error as string | null | undefined) ?? null,
    metadata: (row.metadata as Record<string, unknown> | null | undefined) ?? {},
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

async function getPlanByIdInternal(
  db: DatabaseExecutor,
  params: { planId: string; organizationId: string; projectId: string }
): Promise<PaymentSubscriptionPlanRow | null> {
  const row = await db
    .prepare(
      `SELECT *
         FROM payment_subscription_plans
        WHERE id = ?
          AND organization_id = ?
          AND project_id = ?`
    )
    .bind(params.planId, params.organizationId, params.projectId)
    .first<Record<string, unknown>>();

  return row ? mapPlanRow(row) : null;
}

async function getSubscriptionByIdInternal(
  db: DatabaseExecutor,
  params: { subscriptionId: string; organizationId: string; projectId: string }
): Promise<PaymentSubscriptionRow | null> {
  const row = await db
    .prepare(
      `SELECT *
         FROM payment_subscriptions
        WHERE id = ?
          AND organization_id = ?
          AND project_id = ?`
    )
    .bind(params.subscriptionId, params.organizationId, params.projectId)
    .first<Record<string, unknown>>();

  return row ? mapSubscriptionRow(row) : null;
}

async function getAttemptByIdInternal(
  db: DatabaseExecutor,
  id: string
): Promise<PaymentSubscriptionCollectionAttemptRow | null> {
  const row = await db
    .prepare("SELECT * FROM payment_subscription_collection_attempts WHERE id = ?")
    .bind(id)
    .first<Record<string, unknown>>();

  return row ? mapAttemptRow(row) : null;
}

async function expireStaleUnsignedProcessingAttemptsWithExecutor(
  db: DatabaseExecutor,
  params: ExpireStaleUnsignedProcessingAttemptsInput
): Promise<number> {
  // A submitted collect operation with a signature is a recovery marker; unsigned
  // processing/submitted operation claims are stale and expire with the attempt.
  const result = await db.queryOne<{
    expired_linked_attempts: number;
    expired_failed_attempt_transfers: number;
    expired_unlinked_attempts: number;
    expired_collect_operation_attempts: number;
  }>(
    `WITH submitted_collect_claims AS (
          SELECT recurring_payment_id
            FROM payment_recurring_operation_attempts
           WHERE operation = 'collect'
             AND status IN ('processing', 'submitted')
             AND signature IS NOT NULL
        ),
        stale_linked AS (
          SELECT a.id AS attempt_id,
                 a.transfer_id AS transfer_id,
                 a.recurring_payment_id AS recurring_payment_id
            FROM payment_subscription_collection_attempts a
            JOIN payment_transfers t
              ON t.id = a.transfer_id
             AND t.organization_id = a.organization_id
             AND t.project_id = a.project_id
           WHERE a.status = 'processing'
             AND a.recurring_payment_id IS NOT NULL
             AND a.transfer_id IS NOT NULL
             AND a.signature IS NULL
             AND a.updated_at <= ?
             AND t.status = 'processing'
             AND t.signature IS NULL
             AND NOT EXISTS (
                   SELECT 1
                     FROM submitted_collect_claims submitted
                    WHERE submitted.recurring_payment_id = a.recurring_payment_id
                 )
           ORDER BY a.updated_at ASC
           LIMIT ?
        ),
        stale_failed_attempt_transfers AS (
          SELECT t.id AS transfer_id,
                 a.recurring_payment_id AS recurring_payment_id
            FROM payment_subscription_collection_attempts a
            JOIN payment_transfers t
              ON t.id = a.transfer_id
             AND t.organization_id = a.organization_id
             AND t.project_id = a.project_id
           WHERE a.status = 'failed'
             AND a.recurring_payment_id IS NOT NULL
             AND a.transfer_id IS NOT NULL
             AND a.signature IS NULL
             AND a.updated_at <= ?
             AND t.status = 'processing'
             AND t.signature IS NULL
             AND NOT EXISTS (
                   SELECT 1
                     FROM submitted_collect_claims submitted
                    WHERE submitted.recurring_payment_id = a.recurring_payment_id
                 )
           ORDER BY a.updated_at ASC
           LIMIT ?
        ),
        stale_unlinked AS (
          SELECT a.id AS attempt_id,
                 a.recurring_payment_id AS recurring_payment_id
            FROM payment_subscription_collection_attempts a
           WHERE a.status = 'processing'
             AND a.recurring_payment_id IS NOT NULL
             AND a.transfer_id IS NULL
             AND a.signature IS NULL
             AND a.updated_at <= ?
             AND NOT EXISTS (
                   SELECT 1
                     FROM submitted_collect_claims submitted
                    WHERE submitted.recurring_payment_id = a.recurring_payment_id
                 )
           ORDER BY a.updated_at ASC
           LIMIT ?
        ),
        updated_linked_transfers AS (
          UPDATE payment_transfers t
             SET status = 'failed',
                 error = COALESCE(error, 'Stale recurring collection transfer expired before submission'),
                 updated_at = ?
            FROM stale_linked stale
           WHERE t.id = stale.transfer_id
           RETURNING t.id
        ),
        updated_linked_attempts AS (
          UPDATE payment_subscription_collection_attempts a
             SET status = 'failed',
                 error = COALESCE(error, 'Stale recurring collection attempt expired before submission'),
                 attempted_at = COALESCE(attempted_at, ?),
                 updated_at = ?
            FROM stale_linked stale
           WHERE a.id = stale.attempt_id
           RETURNING a.id
        ),
        updated_failed_attempt_transfers AS (
          UPDATE payment_transfers t
             SET status = 'failed',
                 error = COALESCE(error, 'Stale recurring collection transfer expired after failed attempt'),
                 updated_at = ?
            FROM stale_failed_attempt_transfers stale
           WHERE t.id = stale.transfer_id
           RETURNING t.id
        ),
        updated_unlinked_attempts AS (
          UPDATE payment_subscription_collection_attempts a
             SET status = 'failed',
                 error = COALESCE(error, 'Stale recurring collection attempt expired before transfer submission'),
                 attempted_at = COALESCE(attempted_at, ?),
                 updated_at = ?
            FROM stale_unlinked stale
           WHERE a.id = stale.attempt_id
           RETURNING a.id
        ),
        stale_collect_claims AS (
          SELECT recurring_payment_id FROM stale_linked
          UNION
          SELECT recurring_payment_id FROM stale_failed_attempt_transfers
          UNION
          SELECT recurring_payment_id FROM stale_unlinked
        ),
        updated_collect_operation_attempts AS (
          UPDATE payment_recurring_operation_attempts op
             SET status = 'failed',
                 error = COALESCE(error, 'Stale recurring collection operation expired before submission'),
                 updated_at = ?
            FROM stale_collect_claims stale
           WHERE op.recurring_payment_id = stale.recurring_payment_id
             AND op.operation = 'collect'
             AND op.status IN ('processing', 'submitted')
           RETURNING op.id
        )
      SELECT (SELECT COUNT(*)::int FROM updated_linked_attempts) AS expired_linked_attempts,
             (SELECT COUNT(*)::int FROM updated_failed_attempt_transfers) AS expired_failed_attempt_transfers,
             (SELECT COUNT(*)::int FROM updated_unlinked_attempts) AS expired_unlinked_attempts,
             (SELECT COUNT(*)::int FROM updated_collect_operation_attempts) AS expired_collect_operation_attempts`,
    [
      params.olderThan,
      params.limit,
      params.olderThan,
      params.limit,
      params.olderThan,
      params.limit,
      params.updatedAt,
      params.updatedAt,
      params.updatedAt,
      params.updatedAt,
      params.updatedAt,
      params.updatedAt,
      params.updatedAt,
    ]
  );

  return (
    (result?.expired_linked_attempts ?? 0) +
    (result?.expired_failed_attempt_transfers ?? 0) +
    (result?.expired_unlinked_attempts ?? 0)
  );
}

export function createPostgresPaymentSubscriptionsRepository(
  db: DatabaseExecutor
): PaymentSubscriptionsRepository {
  return {
    async createPlan(input: CreatePaymentSubscriptionPlanInput) {
      await db
        .prepare(
          `INSERT INTO payment_subscription_plans (
             id,
             organization_id,
             project_id,
             owner_wallet_id,
             owner_address,
             token,
             amount,
             period_hours,
             program_plan_id,
             plan_pda,
             destination_address,
             puller_wallet_id,
             puller_address,
             metadata_uri,
             status,
             created_by,
             created_at,
             updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT DO NOTHING`
        )
        .bind(
          input.id,
          input.organizationId,
          input.projectId,
          input.ownerWalletId,
          input.ownerAddress,
          input.token,
          input.amount,
          input.periodHours,
          input.programPlanId,
          input.planPda,
          input.destinationAddress,
          input.pullerWalletId,
          input.pullerAddress,
          input.metadataUri,
          input.status,
          input.createdBy,
          input.createdAt,
          input.updatedAt
        )
        .run();

      return getPlanByIdInternal(db, {
        planId: input.id,
        organizationId: input.organizationId,
        projectId: input.projectId,
      });
    },

    async updatePlan(input: UpdatePaymentSubscriptionPlanInput) {
      const existing = await getPlanByIdInternal(db, {
        planId: input.planId,
        organizationId: input.organizationId,
        projectId: input.projectId,
      });
      if (!existing) return null;

      await db
        .prepare(
          `UPDATE payment_subscription_plans
              SET plan_pda = CASE WHEN ?::boolean THEN ? ELSE plan_pda END,
                  destination_address = CASE WHEN ?::boolean THEN ? ELSE destination_address END,
                  puller_wallet_id = CASE WHEN ?::boolean THEN ? ELSE puller_wallet_id END,
                  puller_address = CASE WHEN ?::boolean THEN ? ELSE puller_address END,
                  metadata_uri = CASE WHEN ?::boolean THEN ? ELSE metadata_uri END,
                  status = COALESCE(?, status),
                  updated_at = ?
            WHERE id = ?
              AND organization_id = ?
              AND project_id = ?`
        )
        .bind(
          input.planPda !== undefined,
          input.planPda ?? null,
          input.destinationAddress !== undefined,
          input.destinationAddress ?? null,
          input.pullerWalletId !== undefined,
          input.pullerWalletId ?? null,
          input.pullerAddress !== undefined,
          input.pullerAddress ?? null,
          input.metadataUri !== undefined,
          input.metadataUri ?? null,
          input.status ?? null,
          input.updatedAt,
          input.planId,
          input.organizationId,
          input.projectId
        )
        .run();

      return getPlanByIdInternal(db, {
        planId: input.planId,
        organizationId: input.organizationId,
        projectId: input.projectId,
      });
    },

    getPlanById(params) {
      return getPlanByIdInternal(db, params);
    },

    async listPlans(params: ListPaymentSubscriptionPlansInput) {
      const clauses = ["p.organization_id = ?", "p.project_id = ?"];
      const values: unknown[] = [params.organizationId, params.projectId];

      if (params.status) {
        clauses.push("p.status = ?");
        values.push(params.status);
      }
      if (params.planWalletIds) {
        if (params.planWalletIds.length === 0) {
          clauses.push("1 = 0");
        } else {
          const walletClause = buildInClause(params.planWalletIds.length);
          clauses.push(
            `(p.owner_wallet_id IN (${walletClause}) OR p.puller_wallet_id IN (${walletClause}))`
          );
          values.push(...params.planWalletIds, ...params.planWalletIds);
        }
      }

      const whereClause = clauses.join(" AND ");
      const [rows, countRow] = await Promise.all([
        db
          .prepare(
            `SELECT p.*
               FROM payment_subscription_plans p
              WHERE ${whereClause}
              ORDER BY p.created_at DESC
              LIMIT ? OFFSET ?`
          )
          .bind(...values, params.limit, params.offset)
          .all<Record<string, unknown>>(),
        db
          .prepare(
            `SELECT COUNT(*)::int AS total
               FROM payment_subscription_plans p
              WHERE ${whereClause}`
          )
          .bind(...values)
          .first<{ total: number }>(),
      ]);

      return {
        rows: rows.results.map(mapPlanRow),
        total: countRow?.total ?? 0,
      } satisfies ListPaymentSubscriptionPlansResult;
    },

    async createSubscription(input: CreatePaymentSubscriptionInput) {
      await db
        .prepare(
          `INSERT INTO payment_subscriptions (
             id,
             organization_id,
             project_id,
             plan_id,
             counterparty_id,
             subscriber_address,
             subscriber_token_account,
             subscription_pda,
             subscription_authority_address,
             authorization_signature,
             status,
             current_period_start_at,
             next_collection_due_at,
             created_by,
             created_at,
             updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (organization_id, project_id, plan_id, counterparty_id) DO NOTHING`
        )
        .bind(
          input.id,
          input.organizationId,
          input.projectId,
          input.planId,
          input.counterpartyId,
          input.subscriberAddress,
          input.subscriberTokenAccount,
          input.subscriptionPda,
          input.subscriptionAuthorityAddress,
          input.authorizationSignature,
          input.status,
          input.currentPeriodStartAt,
          input.nextCollectionDueAt,
          input.createdBy,
          input.createdAt,
          input.updatedAt
        )
        .run();

      return getSubscriptionByIdInternal(db, {
        subscriptionId: input.id,
        organizationId: input.organizationId,
        projectId: input.projectId,
      });
    },

    async updateSubscription(input: UpdatePaymentSubscriptionInput) {
      const whereClauses = ["id = ?", "organization_id = ?", "project_id = ?"];
      const whereValues: unknown[] = [input.subscriptionId, input.organizationId, input.projectId];

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
          `UPDATE payment_subscriptions
              SET subscriber_token_account =
                    CASE WHEN ?::boolean THEN ? ELSE subscriber_token_account END,
                  subscription_pda = CASE WHEN ?::boolean THEN ? ELSE subscription_pda END,
                  subscription_authority_address =
                    CASE WHEN ?::boolean THEN ? ELSE subscription_authority_address END,
                  authorization_signature =
                    CASE WHEN ?::boolean THEN ? ELSE authorization_signature END,
                  status = COALESCE(?, status),
                  current_period_start_at =
                    CASE WHEN ?::boolean THEN ? ELSE current_period_start_at END,
                  next_collection_due_at =
                    CASE WHEN ?::boolean THEN ? ELSE next_collection_due_at END,
                  cancel_at = CASE WHEN ?::boolean THEN ? ELSE cancel_at END,
                  canceled_at = CASE WHEN ?::boolean THEN ? ELSE canceled_at END,
                  updated_at = ?
            WHERE ${whereClauses.join(" AND ")}`
        )
        .bind(
          input.subscriberTokenAccount !== undefined,
          input.subscriberTokenAccount ?? null,
          input.subscriptionPda !== undefined,
          input.subscriptionPda ?? null,
          input.subscriptionAuthorityAddress !== undefined,
          input.subscriptionAuthorityAddress ?? null,
          input.authorizationSignature !== undefined,
          input.authorizationSignature ?? null,
          input.status ?? null,
          input.currentPeriodStartAt !== undefined,
          input.currentPeriodStartAt ?? null,
          input.nextCollectionDueAt !== undefined,
          input.nextCollectionDueAt ?? null,
          input.cancelAt !== undefined,
          input.cancelAt ?? null,
          input.canceledAt !== undefined,
          input.canceledAt ?? null,
          input.updatedAt,
          ...whereValues
        )
        .run();

      if (changes === 0) {
        return null;
      }

      return getSubscriptionByIdInternal(db, {
        subscriptionId: input.subscriptionId,
        organizationId: input.organizationId,
        projectId: input.projectId,
      });
    },

    getSubscriptionById(params) {
      return getSubscriptionByIdInternal(db, params);
    },

    async listSubscriptions(params: ListPaymentSubscriptionsInput) {
      const clauses = ["s.organization_id = ?", "s.project_id = ?"];
      const values: unknown[] = [params.organizationId, params.projectId];

      if (params.planId) {
        clauses.push("s.plan_id = ?");
        values.push(params.planId);
      }
      if (params.counterpartyId) {
        clauses.push("s.counterparty_id = ?");
        values.push(params.counterpartyId);
      }
      if (params.status) {
        clauses.push("s.status = ?");
        values.push(params.status);
      }
      if (params.dueBefore) {
        clauses.push("s.next_collection_due_at <= ?");
        values.push(params.dueBefore);
      }
      if (params.planWalletIds) {
        if (params.planWalletIds.length === 0) {
          clauses.push("1 = 0");
        } else {
          const walletClause = buildInClause(params.planWalletIds.length);
          clauses.push(`EXISTS (
            SELECT 1
              FROM payment_subscription_plans p
             WHERE p.id = s.plan_id
               AND p.organization_id = s.organization_id
               AND p.project_id = s.project_id
               AND (p.owner_wallet_id IN (${walletClause}) OR p.puller_wallet_id IN (${walletClause}))
          )`);
          values.push(...params.planWalletIds, ...params.planWalletIds);
        }
      }

      const whereClause = clauses.join(" AND ");
      const [rows, countRow] = await Promise.all([
        db
          .prepare(
            `SELECT s.*
               FROM payment_subscriptions s
              WHERE ${whereClause}
              ORDER BY s.created_at DESC
              LIMIT ? OFFSET ?`
          )
          .bind(...values, params.limit, params.offset)
          .all<Record<string, unknown>>(),
        db
          .prepare(
            `SELECT COUNT(*)::int AS total
               FROM payment_subscriptions s
              WHERE ${whereClause}`
          )
          .bind(...values)
          .first<{ total: number }>(),
      ]);

      return {
        rows: rows.results.map(mapSubscriptionRow),
        total: countRow?.total ?? 0,
      } satisfies ListPaymentSubscriptionsResult;
    },

    async createCollectionAttempt(input: CreatePaymentSubscriptionCollectionAttemptInput) {
      await db
        .prepare(
          `INSERT INTO payment_subscription_collection_attempts (
             id,
             organization_id,
             project_id,
             subscription_id,
             recurring_payment_id,
             transfer_id,
             token,
             amount,
             due_at,
             attempted_at,
             status,
             signature,
             error,
             metadata,
             created_at,
             updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT DO NOTHING`
        )
        .bind(
          input.id,
          input.organizationId,
          input.projectId,
          input.subscriptionId,
          input.recurringPaymentId ?? null,
          input.transferId,
          input.token,
          input.amount,
          input.dueAt,
          input.attemptedAt,
          input.status,
          input.signature,
          input.error,
          JSON.stringify(input.metadata),
          input.createdAt,
          input.updatedAt
        )
        .run();

      return getAttemptByIdInternal(db, input.id);
    },

    async updateCollectionAttempt(input: UpdatePaymentSubscriptionCollectionAttemptInput) {
      const updated = await db
        .prepare(
          `UPDATE payment_subscription_collection_attempts
              SET transfer_id = CASE WHEN ?::boolean THEN ? ELSE transfer_id END,
                  attempted_at = CASE WHEN ?::boolean THEN ? ELSE attempted_at END,
                  status = COALESCE(?, status),
                  signature = CASE WHEN ?::boolean THEN ? ELSE signature END,
                  error = CASE WHEN ?::boolean THEN ? ELSE error END,
                  metadata = COALESCE(?, metadata),
                  updated_at = ?
            WHERE id = ?`
        )
        .bind(
          input.transferId !== undefined,
          input.transferId ?? null,
          input.attemptedAt !== undefined,
          input.attemptedAt ?? null,
          input.status ?? null,
          input.signature !== undefined,
          input.signature ?? null,
          input.error !== undefined,
          input.error ?? null,
          input.metadata === undefined ? null : JSON.stringify(input.metadata),
          input.updatedAt,
          input.attemptId
        )
        .run();

      if (updated === 0) {
        return null;
      }

      return getAttemptByIdInternal(db, input.attemptId);
    },

    async expireStaleUnsignedProcessingAttempts(params) {
      if (isTransactionalDatabaseExecutor(db)) {
        return db.transaction((tx) =>
          expireStaleUnsignedProcessingAttemptsWithExecutor(tx, params)
        );
      }

      return expireStaleUnsignedProcessingAttemptsWithExecutor(db, params);
    },

    async listSubmittedRecurringCollectionAttempts(params) {
      const rows = await db
        .prepare(
          `SELECT a.*
           FROM payment_subscription_collection_attempts a
           JOIN payment_transfers t
             ON t.id = a.transfer_id
            AND t.organization_id = a.organization_id
            AND t.project_id = a.project_id
            LEFT JOIN payment_recurring_operation_attempts op
              ON op.recurring_payment_id = a.recurring_payment_id
             AND op.organization_id = a.organization_id
             AND op.project_id = a.project_id
             AND op.operation = 'collect'
             AND op.status IN ('processing', 'submitted')
            WHERE a.recurring_payment_id IS NOT NULL
              AND a.status IN ('processing', 'confirmed')
              AND a.transfer_id IS NOT NULL
              AND (a.signature IS NOT NULL OR t.signature IS NOT NULL OR op.signature IS NOT NULL)
              AND (a.status <> 'confirmed' OR t.status NOT IN ('confirmed', 'finalized'))
            ORDER BY a.updated_at ASC
            LIMIT ?`
        )
        .bind(params.limit)
        .all<Record<string, unknown>>();

      return rows.results.map(mapAttemptRow);
    },

    async getCollectionAttemptByRecurringDue(params) {
      const row = await db
        .prepare(
          `SELECT *
             FROM payment_subscription_collection_attempts
            WHERE recurring_payment_id = ?
              AND organization_id = ?
              AND project_id = ?
              AND due_at = ?
              AND status IN ('pending', 'processing', 'confirmed')
            ORDER BY created_at DESC
            LIMIT 1`
        )
        .bind(params.recurringPaymentId, params.organizationId, params.projectId, params.dueAt)
        .first<Record<string, unknown>>();

      return row ? mapAttemptRow(row) : null;
    },

    async listCollectionAttempts(params: ListPaymentSubscriptionCollectionAttemptsInput) {
      const clauses = ["organization_id = ?", "project_id = ?"];
      const values: unknown[] = [params.organizationId, params.projectId];

      if (params.recurringPaymentId) {
        clauses.push("recurring_payment_id = ?");
        values.push(params.recurringPaymentId);
      } else if (params.subscriptionId) {
        clauses.push("subscription_id = ?");
        values.push(params.subscriptionId);
      } else {
        clauses.push("1 = 0");
      }

      if (params.status) {
        clauses.push("status = ?");
        values.push(params.status);
      }

      const whereClause = clauses.join(" AND ");
      const [rows, countRow] = await Promise.all([
        db
          .prepare(
            `SELECT *
               FROM payment_subscription_collection_attempts
              WHERE ${whereClause}
              ORDER BY created_at DESC
              LIMIT ? OFFSET ?`
          )
          .bind(...values, params.limit, params.offset)
          .all<Record<string, unknown>>(),
        db
          .prepare(
            `SELECT COUNT(*)::int AS total
               FROM payment_subscription_collection_attempts
              WHERE ${whereClause}`
          )
          .bind(...values)
          .first<{ total: number }>(),
      ]);

      return {
        rows: rows.results.map(mapAttemptRow),
        total: countRow?.total ?? 0,
      } satisfies ListPaymentSubscriptionCollectionAttemptsResult;
    },
  };
}
