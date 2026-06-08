import type { AppDb } from "@/db";
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
  UpdatePaymentSubscriptionInput,
  UpdatePaymentSubscriptionPlanInput,
} from "./payment-subscriptions.repository";

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
  db: AppDb,
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
  db: AppDb,
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
  db: AppDb,
  id: string
): Promise<PaymentSubscriptionCollectionAttemptRow | null> {
  const row = await db
    .prepare("SELECT * FROM payment_subscription_collection_attempts WHERE id = ?")
    .bind(id)
    .first<Record<string, unknown>>();

  return row ? mapAttemptRow(row) : null;
}

export function createPostgresPaymentSubscriptionsRepository(
  db: AppDb
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
      const clauses = ["organization_id = ?", "project_id = ?"];
      const values: unknown[] = [params.organizationId, params.projectId];

      if (params.status) {
        clauses.push("status = ?");
        values.push(params.status);
      }

      const whereClause = clauses.join(" AND ");
      const [rows, countRow] = await Promise.all([
        db
          .prepare(
            `SELECT *
               FROM payment_subscription_plans
              WHERE ${whereClause}
              ORDER BY created_at DESC
              LIMIT ? OFFSET ?`
          )
          .bind(...values, params.limit, params.offset)
          .all<Record<string, unknown>>(),
        db
          .prepare(
            `SELECT COUNT(*)::int AS total
               FROM payment_subscription_plans
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
      const existing = await getSubscriptionByIdInternal(db, {
        subscriptionId: input.subscriptionId,
        organizationId: input.organizationId,
        projectId: input.projectId,
      });
      if (!existing) return null;

      await db
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
            WHERE id = ?
              AND organization_id = ?
              AND project_id = ?`
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
          input.subscriptionId,
          input.organizationId,
          input.projectId
        )
        .run();

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
      const clauses = ["organization_id = ?", "project_id = ?"];
      const values: unknown[] = [params.organizationId, params.projectId];

      if (params.planId) {
        clauses.push("plan_id = ?");
        values.push(params.planId);
      }
      if (params.counterpartyId) {
        clauses.push("counterparty_id = ?");
        values.push(params.counterpartyId);
      }
      if (params.status) {
        clauses.push("status = ?");
        values.push(params.status);
      }
      if (params.dueBefore) {
        clauses.push("next_collection_due_at <= ?");
        values.push(params.dueBefore);
      }

      const whereClause = clauses.join(" AND ");
      const [rows, countRow] = await Promise.all([
        db
          .prepare(
            `SELECT *
               FROM payment_subscriptions
              WHERE ${whereClause}
              ORDER BY created_at DESC
              LIMIT ? OFFSET ?`
          )
          .bind(...values, params.limit, params.offset)
          .all<Record<string, unknown>>(),
        db
          .prepare(
            `SELECT COUNT(*)::int AS total
               FROM payment_subscriptions
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
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT DO NOTHING`
        )
        .bind(
          input.id,
          input.organizationId,
          input.projectId,
          input.subscriptionId,
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

    async listCollectionAttempts(params: ListPaymentSubscriptionCollectionAttemptsInput) {
      const clauses = ["organization_id = ?", "project_id = ?", "subscription_id = ?"];
      const values: unknown[] = [params.organizationId, params.projectId, params.subscriptionId];

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
