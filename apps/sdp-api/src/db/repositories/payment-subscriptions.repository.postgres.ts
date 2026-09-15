import {
  PAYMENT_SUBSCRIPTION_COLLECTION_ATTEMPT_STATUSES,
  PAYMENT_SUBSCRIPTION_PLAN_STATUSES,
  PAYMENT_SUBSCRIPTION_STATUSES,
  paymentSubscriptionCollectionAttemptMetadataSchema,
} from "@sdp/types";
import { z } from "zod";
import type { DatabaseExecutor } from "@/db";
import type {
  CreatePaymentSubscriptionCollectionAttemptInput,
  CreatePaymentSubscriptionInput,
  CreatePaymentSubscriptionPlanInput,
  GetPaymentSubscriptionCollectionAttemptByDueInput,
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

const planRowSchema = z.object({
  id: z.string(),
  organization_id: z.string(),
  project_id: z.string(),
  owner_wallet_id: z.string(),
  owner_address: z.string(),
  token: z.string(),
  amount: z.string(),
  period_hours: z.number(),
  program_plan_id: z.string(),
  plan_pda: z.string().nullable(),
  destination_address: z.string().nullable(),
  puller_wallet_id: z.string().nullable(),
  puller_address: z.string().nullable(),
  metadata_uri: z.string().nullable(),
  status: z.enum(PAYMENT_SUBSCRIPTION_PLAN_STATUSES),
  created_by: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});
const subscriptionRowSchema = z.object({
  id: z.string(),
  organization_id: z.string(),
  project_id: z.string(),
  plan_id: z.string(),
  counterparty_id: z.string(),
  subscriber_address: z.string(),
  subscriber_token_account: z.string().nullable(),
  subscription_pda: z.string().nullable(),
  subscription_authority_address: z.string().nullable(),
  authorization_signature: z.string().nullable(),
  status: z.enum(PAYMENT_SUBSCRIPTION_STATUSES),
  current_period_start_at: z.string().nullable(),
  next_collection_due_at: z.string().nullable(),
  cancel_at: z.string().nullable(),
  canceled_at: z.string().nullable(),
  created_by: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});
const attemptRowSchema = z.object({
  id: z.string(),
  organization_id: z.string(),
  project_id: z.string(),
  subscription_id: z.string(),
  transfer_id: z.string().nullable(),
  token: z.string(),
  amount: z.string(),
  due_at: z.string(),
  attempted_at: z.string().nullable(),
  status: z.enum(PAYMENT_SUBSCRIPTION_COLLECTION_ATTEMPT_STATUSES),
  signature: z.string().nullable(),
  error: z.string().nullable(),
  metadata: paymentSubscriptionCollectionAttemptMetadataSchema,
  created_at: z.string(),
  updated_at: z.string(),
});

function mapPlanRow(row: Record<string, unknown>): PaymentSubscriptionPlanRow {
  return planRowSchema.parse(row);
}

function mapSubscriptionRow(row: Record<string, unknown>): PaymentSubscriptionRow {
  return subscriptionRowSchema.parse(row);
}

function mapAttemptRow(row: Record<string, unknown>): PaymentSubscriptionCollectionAttemptRow {
  return attemptRowSchema.parse(row);
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
  params: { attemptId: string; organizationId?: string; projectId?: string }
): Promise<PaymentSubscriptionCollectionAttemptRow | null> {
  const clauses = ["id = ?"];
  const values: unknown[] = [params.attemptId];

  if (params.organizationId) {
    clauses.push("organization_id = ?");
    values.push(params.organizationId);
  }
  if (params.projectId) {
    clauses.push("project_id = ?");
    values.push(params.projectId);
  }

  const row = await db
    .prepare(
      `SELECT * FROM payment_subscription_collection_attempts WHERE ${clauses.join(" AND ")}`
    )
    .bind(...values)
    .first<Record<string, unknown>>();

  return row ? mapAttemptRow(row) : null;
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

      const row = await db
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
              AND project_id = ?
              AND (?::boolean = false OR next_collection_due_at IS NOT DISTINCT FROM ?)
              AND (?::boolean = false OR status = ?::text)
          RETURNING *`
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
          input.projectId,
          input.expectedNextCollectionDueAt !== undefined,
          input.expectedNextCollectionDueAt ?? null,
          input.expectedStatus !== undefined,
          input.expectedStatus ?? null
        )
        .first<Record<string, unknown>>();

      return row ? mapSubscriptionRow(row) : null;
    },

    getSubscriptionById(params) {
      return getSubscriptionByIdInternal(db, params);
    },

    async getCollectionAttemptByDue(params: GetPaymentSubscriptionCollectionAttemptByDueInput) {
      const clauses = [
        "organization_id = ?",
        "project_id = ?",
        "subscription_id = ?",
        "due_at = ?",
      ];
      const values: unknown[] = [
        params.organizationId,
        params.projectId,
        params.subscriptionId,
        params.dueAt,
      ];

      if (params.statuses?.length) {
        clauses.push(`status IN (${params.statuses.map(() => "?").join(", ")})`);
        values.push(...params.statuses);
      }

      const row = await db
        .prepare(
          `SELECT *
             FROM payment_subscription_collection_attempts
            WHERE ${clauses.join(" AND ")}
            ORDER BY updated_at DESC
            LIMIT 1`
        )
        .bind(...values)
        .first<Record<string, unknown>>();

      return row ? mapAttemptRow(row) : null;
    },

    getCollectionAttemptById(params) {
      return getAttemptByIdInternal(db, params);
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
      if (params.subscriberAddress) {
        clauses.push("subscriber_address = ?");
        values.push(params.subscriberAddress);
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

      return getAttemptByIdInternal(db, {
        attemptId: input.id,
        organizationId: input.organizationId,
        projectId: input.projectId,
      });
    },

    async updateCollectionAttempt(input: UpdatePaymentSubscriptionCollectionAttemptInput) {
      const row = await db
        .prepare(
          `UPDATE payment_subscription_collection_attempts
              SET transfer_id = CASE WHEN ?::boolean THEN ? ELSE transfer_id END,
                  attempted_at = CASE WHEN ?::boolean THEN ? ELSE attempted_at END,
                  status = COALESCE(?, status),
                  signature = CASE WHEN ?::boolean THEN ? ELSE signature END,
                  error = CASE WHEN ?::boolean THEN ? ELSE error END,
                  metadata = CASE WHEN ?::boolean THEN ?::jsonb ELSE metadata END,
                  updated_at = ?
            WHERE id = ?
              AND organization_id = ?
              AND project_id = ?
              AND (
                ?::text IS NULL
                OR ?::text = status
                OR (?::text = 'processing' AND status = 'pending')
                OR (?::text = 'confirmed' AND status IN ('pending', 'processing'))
                OR (?::text = 'failed' AND status IN ('pending', 'processing'))
              )
          RETURNING *`
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
          input.metadata !== undefined,
          JSON.stringify(input.metadata ?? {}),
          input.updatedAt,
          input.attemptId,
          input.organizationId,
          input.projectId,
          input.status ?? null,
          input.status ?? null,
          input.status ?? null,
          input.status ?? null,
          input.status ?? null
        )
        .first<Record<string, unknown>>();

      return row ? mapAttemptRow(row) : null;
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
