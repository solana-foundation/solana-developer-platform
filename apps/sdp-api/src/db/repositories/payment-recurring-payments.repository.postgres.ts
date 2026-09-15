import {
  COLLECTION_ATTEMPT_STATUSES_BLOCKING_NEW_CYCLE,
  COLLECTION_ATTEMPT_STATUSES_WITH_SUBMITTED_TRANSFER,
  PAYMENT_RECURRING_PAYMENT_ACTIVATION_ATTEMPT_STAGES,
  PAYMENT_RECURRING_PAYMENT_ATTEMPT_STATUSES,
  PAYMENT_RECURRING_PAYMENT_LIFECYCLE_ATTEMPT_STAGES,
  PAYMENT_RECURRING_PAYMENT_LIFECYCLE_OPERATIONS,
  PAYMENT_RECURRING_PAYMENT_STATUSES,
  PAYMENT_RECURRING_PAYMENT_UPDATE_ATTEMPT_MODES,
  PAYMENT_RECURRING_PAYMENT_UPDATE_ATTEMPT_STAGES,
  RECURRING_PAYMENT_LIFECYCLE_TRANSITIONS,
  RECURRING_PAYMENT_STATUSES_RECOVERABLE_BY_CRON,
  RECURRING_PAYMENT_STATUSES_WITH_RECOVERABLE_COLLECTION,
} from "@sdp/types";
import { z } from "zod";
import type { DatabaseExecutor } from "@/db";
import { AppError } from "@/lib/errors";
import type {
  ClaimPaymentRecurringPaymentLifecycleInput,
  ClaimPaymentRecurringPaymentUpdateInput,
  CollectibleRecurringPaymentRow,
  CreatePaymentRecurringPaymentActivationAttemptInput,
  CreatePaymentRecurringPaymentInput,
  CreatePaymentRecurringPaymentLifecycleAttemptInput,
  CreatePaymentRecurringPaymentUpdateAttemptInput,
  CreatePaymentRecurringPaymentUpdateEventInput,
  GetLatestPaymentRecurringPaymentActivationAttemptInput,
  GetLatestPaymentRecurringPaymentLifecycleAttemptInput,
  GetLatestPaymentRecurringPaymentUpdateAttemptInput,
  ListPaymentRecurringPaymentsInput,
  ListPaymentRecurringPaymentsResult,
  PaymentRecurringPaymentActivationAttemptRow,
  PaymentRecurringPaymentLifecycleAttemptRow,
  PaymentRecurringPaymentRow,
  PaymentRecurringPaymentsRepository,
  PaymentRecurringPaymentUpdateAttemptRow,
  PaymentRecurringPaymentUpdateEventRow,
  PaymentRecurringWalletAuthorization,
  StalePaymentRecurringPaymentUpdateRow,
  UpdatePaymentRecurringPaymentActivationAttemptInput,
  UpdatePaymentRecurringPaymentActivationInput,
  UpdatePaymentRecurringPaymentCollectionInput,
  UpdatePaymentRecurringPaymentDestinationTokenAccountInput,
  UpdatePaymentRecurringPaymentInput,
  UpdatePaymentRecurringPaymentLifecycleAttemptInput,
  UpdatePaymentRecurringPaymentLifecycleInput,
  UpdatePaymentRecurringPaymentUpdateAttemptInput,
} from "./payment-recurring-payments.repository";

type DatabaseBindValues = Parameters<ReturnType<DatabaseExecutor["prepare"]>["bind"]>;

function addWalletAuthorization(
  clauses: string[],
  values: DatabaseBindValues,
  authorization: PaymentRecurringWalletAuthorization | null
): void {
  if (!authorization) return;

  const authorizationClauses: string[] = [];
  if (authorization.custodyWalletIds.length > 0) {
    authorizationClauses.push("source_custody_wallet_id = ANY(?::text[])");
    values.push(authorization.custodyWalletIds);
  }
  if (authorization.providerWalletIds.length > 0) {
    authorizationClauses.push(
      "(source_custody_wallet_id IS NULL AND source_wallet_id = ANY(?::text[]))"
    );
    values.push(authorization.providerWalletIds);
  }
  clauses.push(
    authorizationClauses.length > 0 ? `(${authorizationClauses.join(" OR ")})` : "1 = 0"
  );
}

function toPostgresTextArray(values: string[]): string {
  const escaped = values.map(
    (value) => `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`
  );
  return `{${escaped.join(",")}}`;
}

const recurringPaymentRowSchema = z.object({
  id: z.string(),
  organization_id: z.string(),
  project_id: z.string(),
  source_custody_wallet_id: z.string().min(1).nullable(),
  source_wallet_id: z.string(),
  source_address: z.string(),
  counterparty_id: z.string(),
  counterparty_account_id: z.string(),
  destination_address: z.string(),
  destination_token_account: z.string().nullable(),
  token: z.string(),
  amount: z.string(),
  period_hours: z.number(),
  first_collection_at: z.string().nullable(),
  next_collection_due_at: z.string().nullable(),
  plan_id: z.string().nullable(),
  subscription_id: z.string().nullable(),
  plan_pda: z.string().nullable(),
  plan_created_at: z.string().nullable(),
  plan_creation_signature: z.string().nullable(),
  subscription_pda: z.string().nullable(),
  subscription_authority_address: z.string().nullable(),
  authorization_signature: z.string().nullable(),
  status: z.enum(PAYMENT_RECURRING_PAYMENT_STATUSES),
  metadata_uri: z.string().nullable(),
  created_by: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});
const activationAttemptRowSchema = z.object({
  id: z.string(),
  organization_id: z.string(),
  project_id: z.string(),
  recurring_payment_id: z.string(),
  status: z.enum(PAYMENT_RECURRING_PAYMENT_ATTEMPT_STATUSES),
  stage: z.enum(PAYMENT_RECURRING_PAYMENT_ACTIVATION_ATTEMPT_STAGES),
  plan_creation_signature: z.string().nullable(),
  authorization_signature: z.string().nullable(),
  error: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()),
  created_at: z.string(),
  updated_at: z.string(),
});
const lifecycleAttemptRowSchema = z.object({
  id: z.string(),
  organization_id: z.string(),
  project_id: z.string(),
  recurring_payment_id: z.string(),
  operation: z.enum(PAYMENT_RECURRING_PAYMENT_LIFECYCLE_OPERATIONS),
  status: z.enum(PAYMENT_RECURRING_PAYMENT_ATTEMPT_STATUSES),
  stage: z.enum(PAYMENT_RECURRING_PAYMENT_LIFECYCLE_ATTEMPT_STAGES),
  signature: z.string().nullable(),
  error: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()),
  created_at: z.string(),
  updated_at: z.string(),
});
const updateAttemptRowSchema = z.object({
  id: z.string(),
  organization_id: z.string(),
  project_id: z.string(),
  recurring_payment_id: z.string(),
  mode: z.enum(PAYMENT_RECURRING_PAYMENT_UPDATE_ATTEMPT_MODES),
  status: z.enum(PAYMENT_RECURRING_PAYMENT_ATTEMPT_STATUSES),
  stage: z.enum(PAYMENT_RECURRING_PAYMENT_UPDATE_ATTEMPT_STAGES),
  old_plan_id: z.string().nullable(),
  old_subscription_id: z.string().nullable(),
  new_plan_id: z.string().nullable(),
  new_subscription_id: z.string().nullable(),
  new_source_custody_wallet_id: z.string().min(1).nullable(),
  plan_update_signature: z.string().nullable(),
  plan_creation_signature: z.string().nullable(),
  authorization_setup_signature: z.string().nullable(),
  authorization_signature: z.string().nullable(),
  old_cancel_signature: z.string().nullable(),
  changed_fields: z.array(z.string()),
  before_values: z.record(z.string(), z.unknown()),
  after_values: z.record(z.string(), z.unknown()),
  error: z.string().nullable(),
  created_by: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});
const updateEventRowSchema = z.object({
  id: z.string(),
  organization_id: z.string(),
  project_id: z.string(),
  recurring_payment_id: z.string(),
  attempt_id: z.string().nullable(),
  changed_fields: z.array(z.string()),
  before_values: z.record(z.string(), z.unknown()),
  after_values: z.record(z.string(), z.unknown()),
  created_by: z.string().nullable(),
  created_at: z.string(),
});
const staleUpdateRowSchema = z.object({
  id: z.string(),
  organization_id: z.string(),
  project_id: z.string(),
  updated_at: z.string(),
  oldest_updated_at: z.string(),
  stale_count: z.number(),
});

function mapRecurringPaymentRow(row: Record<string, unknown>): PaymentRecurringPaymentRow {
  return recurringPaymentRowSchema.parse(row);
}

const collectibleRecurringPaymentProjectionSchema = z.object({
  status: z.literal("active"),
  subscription_id: z.string(),
  next_collection_due_at: z.string(),
});

function mapCollectibleRecurringPaymentRow(
  row: Record<string, unknown>
): CollectibleRecurringPaymentRow {
  const recurringPayment = mapRecurringPaymentRow(row);
  const projection = collectibleRecurringPaymentProjectionSchema.parse(recurringPayment);
  return { ...recurringPayment, ...projection };
}

function mapActivationAttemptRow(
  row: Record<string, unknown>
): PaymentRecurringPaymentActivationAttemptRow {
  return activationAttemptRowSchema.parse(row);
}

function mapLifecycleAttemptRow(
  row: Record<string, unknown>
): PaymentRecurringPaymentLifecycleAttemptRow {
  return lifecycleAttemptRowSchema.parse(row);
}

function mapUpdateAttemptRow(
  row: Record<string, unknown>
): PaymentRecurringPaymentUpdateAttemptRow {
  return updateAttemptRowSchema.parse(row);
}

function mapUpdateEventRow(row: Record<string, unknown>): PaymentRecurringPaymentUpdateEventRow {
  return updateEventRowSchema.parse(row);
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

async function getLifecycleAttemptByIdInternal(
  db: DatabaseExecutor,
  params: { attemptId: string; organizationId: string; projectId: string }
): Promise<PaymentRecurringPaymentLifecycleAttemptRow | null> {
  const row = await db
    .prepare(
      `SELECT *
         FROM payment_recurring_payment_lifecycle_attempts
        WHERE id = ?
          AND organization_id = ?
          AND project_id = ?`
    )
    .bind(params.attemptId, params.organizationId, params.projectId)
    .first<Record<string, unknown>>();

  return row ? mapLifecycleAttemptRow(row) : null;
}

async function getUpdateAttemptByIdInternal(
  db: DatabaseExecutor,
  params: { attemptId: string; organizationId: string; projectId: string }
): Promise<PaymentRecurringPaymentUpdateAttemptRow | null> {
  const row = await db
    .prepare(
      `SELECT *
         FROM payment_recurring_payment_update_attempts
        WHERE id = ?
          AND organization_id = ?
          AND project_id = ?`
    )
    .bind(params.attemptId, params.organizationId, params.projectId)
    .first<Record<string, unknown>>();

  return row ? mapUpdateAttemptRow(row) : null;
}

async function getUpdateEventByIdInternal(
  db: DatabaseExecutor,
  params: { eventId: string; organizationId: string; projectId: string }
): Promise<PaymentRecurringPaymentUpdateEventRow | null> {
  const row = await db
    .prepare(
      `SELECT *
         FROM payment_recurring_payment_update_events
        WHERE id = ?
          AND organization_id = ?
          AND project_id = ?`
    )
    .bind(params.eventId, params.organizationId, params.projectId)
    .first<Record<string, unknown>>();

  return row ? mapUpdateEventRow(row) : null;
}

export function createPostgresPaymentRecurringPaymentsRepository(
  db: DatabaseExecutor
): PaymentRecurringPaymentsRepository {
  return {
    async listStaleLifecyclePayments({ staleBefore, limit }) {
      const result = await db
        .prepare(
          `SELECT * FROM payment_recurring_payments
          WHERE status = ANY(?::text[])
            AND updated_at <= ? ORDER BY updated_at ASC LIMIT ?`
        )
        .bind([...RECURRING_PAYMENT_STATUSES_RECOVERABLE_BY_CRON], staleBefore, limit)
        .all<Record<string, unknown>>();
      return result.rows.map(mapRecurringPaymentRow);
    },
    async listStaleUpdatePayments({ staleBefore, limit }) {
      const result = await db
        .prepare(
          `SELECT organization_id, project_id, id, updated_at,
                COUNT(*) OVER () AS stale_count, MIN(updated_at) OVER () AS oldest_updated_at
           FROM payment_recurring_payments WHERE status = 'updating' AND updated_at <= ?
          ORDER BY updated_at DESC, id DESC LIMIT ?`
        )
        .bind(staleBefore, limit)
        .all<Record<string, unknown>>();
      return result.rows.map(
        (row): StalePaymentRecurringPaymentUpdateRow => staleUpdateRowSchema.parse(row)
      );
    },
    async listRecoverableCollectionPayments({ staleBefore, limit }) {
      const result = await db
        .prepare(
          `SELECT * FROM (
           SELECT rp.*, a.updated_at AS attempt_updated_at,
                  ROW_NUMBER() OVER (PARTITION BY rp.id ORDER BY CASE WHEN a.status = 'confirmed' THEN 0 ELSE 1 END, a.updated_at ASC) AS attempt_rank
             FROM payment_recurring_payments rp
             JOIN payment_subscription_collection_attempts a
               ON a.organization_id = rp.organization_id AND a.project_id = rp.project_id
              AND a.subscription_id = rp.subscription_id AND a.due_at = rp.next_collection_due_at
            WHERE rp.status = ANY(?::text[])
              AND rp.next_collection_due_at IS NOT NULL
              AND a.status = ANY(?::text[])
              AND ((a.status = 'processing' AND a.updated_at <= ?) OR (rp.status = 'active' AND a.status = 'confirmed'))
         ) recoverable_attempts WHERE attempt_rank = 1 ORDER BY attempt_updated_at ASC LIMIT ?`
        )
        .bind(
          [...RECURRING_PAYMENT_STATUSES_WITH_RECOVERABLE_COLLECTION],
          [...COLLECTION_ATTEMPT_STATUSES_WITH_SUBMITTED_TRANSFER],
          staleBefore,
          limit
        )
        .all<Record<string, unknown>>();
      return result.rows.map(mapRecurringPaymentRow);
    },
    async listDueCollectionPayments({ dueBefore, retryBefore, limit }) {
      const result = await db
        .prepare(
          `SELECT rp.* FROM payment_recurring_payments rp
          WHERE rp.status = 'active' AND rp.next_collection_due_at IS NOT NULL AND rp.next_collection_due_at <= ?
            AND NOT EXISTS (SELECT 1 FROM payment_subscription_collection_attempts active_attempt
              WHERE active_attempt.organization_id = rp.organization_id AND active_attempt.project_id = rp.project_id
                AND active_attempt.subscription_id = rp.subscription_id AND active_attempt.due_at = rp.next_collection_due_at
                AND active_attempt.status = ANY(?::text[]))
            AND NOT EXISTS (SELECT 1 FROM payment_subscription_collection_attempts failed_attempt
              WHERE failed_attempt.organization_id = rp.organization_id AND failed_attempt.project_id = rp.project_id
                AND failed_attempt.subscription_id = rp.subscription_id AND failed_attempt.due_at = rp.next_collection_due_at
                AND failed_attempt.status = 'failed' AND failed_attempt.updated_at > ?)
          ORDER BY rp.next_collection_due_at ASC LIMIT ?`
        )
        .bind(dueBefore, [...COLLECTION_ATTEMPT_STATUSES_BLOCKING_NEW_CYCLE], retryBefore, limit)
        .all<Record<string, unknown>>();
      return result.rows.map(mapCollectibleRecurringPaymentRow);
    },
    async createRecurringPayment(input: CreatePaymentRecurringPaymentInput) {
      await db
        .prepare(
          `INSERT INTO payment_recurring_payments (
             id,
             organization_id,
             project_id,
             source_custody_wallet_id,
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
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          input.id,
          input.organizationId,
          input.projectId,
          input.sourceCustodyWalletId,
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

    async updateRecurringPayment(input: UpdatePaymentRecurringPaymentInput) {
      const row = await db
        .prepare(
          `UPDATE payment_recurring_payments
              SET source_custody_wallet_id =
                    CASE WHEN ?::boolean THEN ? ELSE source_custody_wallet_id END,
                  source_wallet_id =
                    CASE WHEN ?::boolean THEN ? ELSE source_wallet_id END,
                  source_address = CASE WHEN ?::boolean THEN ? ELSE source_address END,
                  counterparty_id = CASE WHEN ?::boolean THEN ? ELSE counterparty_id END,
                  counterparty_account_id =
                    CASE WHEN ?::boolean THEN ? ELSE counterparty_account_id END,
                  destination_address =
                    CASE WHEN ?::boolean THEN ? ELSE destination_address END,
                  destination_token_account =
                    CASE WHEN ?::boolean THEN ? ELSE destination_token_account END,
                  token = CASE WHEN ?::boolean THEN ? ELSE token END,
                  amount = CASE WHEN ?::boolean THEN ? ELSE amount END,
                  period_hours = CASE WHEN ?::boolean THEN ? ELSE period_hours END,
                  first_collection_at =
                    CASE WHEN ?::boolean THEN ? ELSE first_collection_at END,
                  next_collection_due_at =
                    CASE WHEN ?::boolean THEN ? ELSE next_collection_due_at END,
                  plan_id = CASE WHEN ?::boolean THEN ? ELSE plan_id END,
                  subscription_id = CASE WHEN ?::boolean THEN ? ELSE subscription_id END,
                  plan_pda = CASE WHEN ?::boolean THEN ? ELSE plan_pda END,
                  plan_created_at =
                    CASE WHEN ?::boolean THEN ? ELSE plan_created_at END,
                  plan_creation_signature =
                    CASE WHEN ?::boolean THEN ? ELSE plan_creation_signature END,
                  subscription_pda =
                    CASE WHEN ?::boolean THEN ? ELSE subscription_pda END,
                  subscription_authority_address =
                    CASE WHEN ?::boolean THEN ? ELSE subscription_authority_address END,
                  authorization_signature =
                    CASE WHEN ?::boolean THEN ? ELSE authorization_signature END,
                  status = COALESCE(?, status),
                  metadata_uri = CASE WHEN ?::boolean THEN ? ELSE metadata_uri END,
                  updated_at = ?
            WHERE id = ?
              AND organization_id = ?
              AND project_id = ?
              AND (?::boolean = false OR status = ?)
              AND (?::boolean = false OR updated_at = ?)
          RETURNING *`
        )
        .bind(
          input.sourceCustodyWalletId !== undefined,
          input.sourceCustodyWalletId ?? null,
          input.sourceWalletId !== undefined,
          input.sourceWalletId ?? null,
          input.sourceAddress !== undefined,
          input.sourceAddress ?? null,
          input.counterpartyId !== undefined,
          input.counterpartyId ?? null,
          input.counterpartyAccountId !== undefined,
          input.counterpartyAccountId ?? null,
          input.destinationAddress !== undefined,
          input.destinationAddress ?? null,
          input.destinationTokenAccount !== undefined,
          input.destinationTokenAccount ?? null,
          input.token !== undefined,
          input.token ?? null,
          input.amount !== undefined,
          input.amount ?? null,
          input.periodHours !== undefined,
          input.periodHours ?? null,
          input.firstCollectionAt !== undefined,
          input.firstCollectionAt ?? null,
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
          input.metadataUri !== undefined,
          input.metadataUri ?? null,
          input.updatedAt,
          input.recurringPaymentId,
          input.organizationId,
          input.projectId,
          input.expectedStatus !== undefined,
          input.expectedStatus ?? null,
          input.expectedUpdatedAt !== undefined,
          input.expectedUpdatedAt ?? null
        )
        .first<Record<string, unknown>>();

      return row ? mapRecurringPaymentRow(row) : null;
    },

    async claimRecurringPaymentActivation(params) {
      const staleBefore = params.staleBefore ?? null;
      const row = await db
        .prepare(
          `UPDATE payment_recurring_payments
              SET status = 'activating',
                  updated_at = ?
            WHERE id = ?
              AND organization_id = ?
              AND project_id = ?
              AND (
                status = 'pending_activation'
                OR (status = 'activating' AND ?::text IS NOT NULL AND updated_at <= ?)
              )
          RETURNING *`
        )
        .bind(
          params.updatedAt,
          params.recurringPaymentId,
          params.organizationId,
          params.projectId,
          staleBefore,
          staleBefore
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
              AND status = 'activating'
          RETURNING *`
        )
        .bind(params.updatedAt, params.recurringPaymentId, params.organizationId, params.projectId)
        .first<Record<string, unknown>>();

      return row ? mapRecurringPaymentRow(row) : null;
    },

    async updateRecurringPaymentActivation(input: UpdatePaymentRecurringPaymentActivationInput) {
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
              AND status = 'activating'
          RETURNING *`
        )
        .bind(
          input.status === undefined ? null : input.status,
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
          input.projectId
        )
        .first<Record<string, unknown>>();

      return row ? mapRecurringPaymentRow(row) : null;
    },

    async updateRecurringPaymentCollection(input: UpdatePaymentRecurringPaymentCollectionInput) {
      const row = await db
        .prepare(
          `UPDATE payment_recurring_payments
              SET next_collection_due_at = ?,
                  destination_token_account =
                    CASE WHEN ?::boolean THEN ? ELSE destination_token_account END,
                  updated_at = ?
            WHERE id = ?
              AND organization_id = ?
              AND project_id = ?
              AND next_collection_due_at = ?
              AND status = 'active'
          RETURNING *`
        )
        .bind(
          input.nextCollectionDueAt,
          input.destinationTokenAccount !== undefined,
          input.destinationTokenAccount ?? null,
          input.updatedAt,
          input.recurringPaymentId,
          input.organizationId,
          input.projectId,
          input.currentCollectionDueAt
        )
        .first<Record<string, unknown>>();

      return row ? mapRecurringPaymentRow(row) : null;
    },

    async updateRecurringPaymentDestinationTokenAccount(
      input: UpdatePaymentRecurringPaymentDestinationTokenAccountInput
    ) {
      const row = await db
        .prepare(
          `UPDATE payment_recurring_payments
              SET destination_token_account = ?,
                  updated_at = ?
            WHERE id = ?
              AND organization_id = ?
              AND project_id = ?
              AND status = 'active'
          RETURNING *`
        )
        .bind(
          input.destinationTokenAccount,
          input.updatedAt,
          input.recurringPaymentId,
          input.organizationId,
          input.projectId
        )
        .first<Record<string, unknown>>();

      return row ? mapRecurringPaymentRow(row) : null;
    },

    async claimRecurringPaymentLifecycle(input: ClaimPaymentRecurringPaymentLifecycleInput) {
      const { processingStatus, claimableStatus } =
        RECURRING_PAYMENT_LIFECYCLE_TRANSITIONS[input.operation];
      const staleBefore = input.staleBefore ?? null;
      const row = await db
        .prepare(
          `UPDATE payment_recurring_payments
              SET status = ?,
                  updated_at = ?
            WHERE id = ?
              AND organization_id = ?
              AND project_id = ?
              AND (
                status = ?
                OR (status = ? AND ?::text IS NOT NULL AND updated_at <= ?)
              )
          RETURNING *`
        )
        .bind(
          processingStatus,
          input.updatedAt,
          input.recurringPaymentId,
          input.organizationId,
          input.projectId,
          claimableStatus,
          processingStatus,
          staleBefore,
          staleBefore
        )
        .first<Record<string, unknown>>();

      return row ? mapRecurringPaymentRow(row) : null;
    },

    async claimRecurringPaymentUpdate(input: ClaimPaymentRecurringPaymentUpdateInput) {
      const staleBefore = input.staleBefore ?? null;
      const row = await db
        .prepare(
          `UPDATE payment_recurring_payments
              SET status = 'updating',
                  updated_at = ?
            WHERE id = ?
              AND organization_id = ?
              AND project_id = ?
              AND (
                status = 'active'
                OR (status = 'updating' AND ?::text IS NOT NULL AND updated_at <= ?)
              )
          RETURNING *`
        )
        .bind(
          input.updatedAt,
          input.recurringPaymentId,
          input.organizationId,
          input.projectId,
          staleBefore,
          staleBefore
        )
        .first<Record<string, unknown>>();

      return row ? mapRecurringPaymentRow(row) : null;
    },

    async updateRecurringPaymentLifecycle(input: UpdatePaymentRecurringPaymentLifecycleInput) {
      const row = await db
        .prepare(
          `UPDATE payment_recurring_payments
              SET status = ?,
                  updated_at = ?
            WHERE id = ?
              AND organization_id = ?
              AND project_id = ?
              AND status = ?
          RETURNING *`
        )
        .bind(
          input.status,
          input.updatedAt,
          input.recurringPaymentId,
          input.organizationId,
          input.projectId,
          input.expectedStatus
        )
        .first<Record<string, unknown>>();

      return row ? mapRecurringPaymentRow(row) : null;
    },

    async createActivationAttempt(input: CreatePaymentRecurringPaymentActivationAttemptInput) {
      await db
        .prepare(
          `INSERT INTO payment_recurring_payment_activation_attempts (
             id,
             organization_id,
             project_id,
             recurring_payment_id,
             status,
             stage,
             plan_creation_signature,
             authorization_signature,
             error,
             metadata,
             created_at,
             updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?)`
        )
        .bind(
          input.id,
          input.organizationId,
          input.projectId,
          input.recurringPaymentId,
          input.status,
          input.stage,
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
      const rowsAffected = await db
        .prepare(
          `UPDATE payment_recurring_payment_activation_attempts
              SET status = COALESCE(?, status),
                  stage = COALESCE(?, stage),
                  plan_creation_signature =
                    CASE WHEN ?::boolean THEN ? ELSE plan_creation_signature END,
                  authorization_signature =
                    CASE WHEN ?::boolean THEN ? ELSE authorization_signature END,
                  error = CASE WHEN ?::boolean THEN ? ELSE error END,
                  metadata = CASE WHEN ?::boolean THEN ?::jsonb ELSE metadata END,
                  updated_at = ?
            WHERE id = ?
              AND organization_id = ?
              AND project_id = ?`
        )
        .bind(
          input.status === undefined ? null : input.status,
          input.stage === undefined ? null : input.stage,
          input.planCreationSignature !== undefined,
          input.planCreationSignature ?? null,
          input.authorizationSignature !== undefined,
          input.authorizationSignature ?? null,
          input.error !== undefined,
          input.error ?? null,
          input.metadata !== undefined,
          input.metadata === undefined ? null : JSON.stringify(input.metadata),
          input.updatedAt,
          input.attemptId,
          input.organizationId,
          input.projectId
        )
        .run();

      if (rowsAffected === 0) return null;

      return getActivationAttemptByIdInternal(db, {
        attemptId: input.attemptId,
        organizationId: input.organizationId,
        projectId: input.projectId,
      });
    },

    async getLatestActivationAttempt(
      input: GetLatestPaymentRecurringPaymentActivationAttemptInput
    ) {
      const clauses = ["organization_id = ?", "project_id = ?", "recurring_payment_id = ?"];
      const values: DatabaseBindValues = [
        input.organizationId,
        input.projectId,
        input.recurringPaymentId,
      ];
      if (input.statuses?.length) {
        clauses.push("status = ANY(?::text[])");
        values.push([...input.statuses]);
      }

      const row = await db
        .prepare(
          `SELECT *
             FROM payment_recurring_payment_activation_attempts
            WHERE ${clauses.join(" AND ")}
            ORDER BY created_at DESC, updated_at DESC, id DESC
            LIMIT 1`
        )
        .bind(...values)
        .first<Record<string, unknown>>();

      return row ? mapActivationAttemptRow(row) : null;
    },

    async createLifecycleAttempt(input: CreatePaymentRecurringPaymentLifecycleAttemptInput) {
      await db
        .prepare(
          `INSERT INTO payment_recurring_payment_lifecycle_attempts (
             id,
             organization_id,
             project_id,
             recurring_payment_id,
             operation,
             status,
             stage,
             signature,
             error,
             metadata,
             created_at,
             updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?)`
        )
        .bind(
          input.id,
          input.organizationId,
          input.projectId,
          input.recurringPaymentId,
          input.operation,
          input.status,
          input.stage,
          input.signature,
          input.error,
          JSON.stringify(input.metadata),
          input.createdAt,
          input.updatedAt
        )
        .run();

      return getLifecycleAttemptByIdInternal(db, {
        attemptId: input.id,
        organizationId: input.organizationId,
        projectId: input.projectId,
      });
    },

    async updateLifecycleAttempt(input: UpdatePaymentRecurringPaymentLifecycleAttemptInput) {
      const row = await db
        .prepare(
          `UPDATE payment_recurring_payment_lifecycle_attempts
              SET status = COALESCE(?, status),
                  stage = COALESCE(?, stage),
                  signature = CASE WHEN ?::boolean THEN ? ELSE signature END,
                  error = CASE WHEN ?::boolean THEN ? ELSE error END,
                  metadata = CASE WHEN ?::boolean THEN ?::jsonb ELSE metadata END,
                  updated_at = ?
            WHERE id = ?
              AND organization_id = ?
              AND project_id = ?
          RETURNING *`
        )
        .bind(
          input.status === undefined ? null : input.status,
          input.stage === undefined ? null : input.stage,
          input.signature !== undefined,
          input.signature ?? null,
          input.error !== undefined,
          input.error ?? null,
          input.metadata !== undefined,
          input.metadata === undefined ? null : JSON.stringify(input.metadata),
          input.updatedAt,
          input.attemptId,
          input.organizationId,
          input.projectId
        )
        .first<Record<string, unknown>>();

      return row ? mapLifecycleAttemptRow(row) : null;
    },

    async getLatestLifecycleAttempt(input: GetLatestPaymentRecurringPaymentLifecycleAttemptInput) {
      const clauses = [
        "organization_id = ?",
        "project_id = ?",
        "recurring_payment_id = ?",
        "operation = ?",
      ];
      const values: DatabaseBindValues = [
        input.organizationId,
        input.projectId,
        input.recurringPaymentId,
        input.operation,
      ];
      if (input.statuses?.length) {
        clauses.push("status = ANY(?::text[])");
        values.push([...input.statuses]);
      }

      const row = await db
        .prepare(
          `SELECT *
             FROM payment_recurring_payment_lifecycle_attempts
            WHERE ${clauses.join(" AND ")}
            ORDER BY created_at DESC, updated_at DESC, id DESC
            LIMIT 1`
        )
        .bind(...values)
        .first<Record<string, unknown>>();

      return row ? mapLifecycleAttemptRow(row) : null;
    },

    async createUpdateAttempt(input: CreatePaymentRecurringPaymentUpdateAttemptInput) {
      await db
        .prepare(
          `INSERT INTO payment_recurring_payment_update_attempts (
             id,
             organization_id,
             project_id,
             recurring_payment_id,
             new_source_custody_wallet_id,
             mode,
             status,
             stage,
             old_plan_id,
             old_subscription_id,
             new_plan_id,
             new_subscription_id,
             plan_update_signature,
             plan_creation_signature,
             authorization_setup_signature,
             authorization_signature,
             old_cancel_signature,
             changed_fields,
             before_values,
             after_values,
             error,
             created_by,
             created_at,
             updated_at
           ) VALUES (
             ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
             ?::text[], ?::jsonb, ?::jsonb, ?, ?, ?, ?
           )`
        )
        .bind(
          input.id,
          input.organizationId,
          input.projectId,
          input.recurringPaymentId,
          input.newSourceCustodyWalletId,
          input.mode,
          input.status,
          input.stage,
          input.oldPlanId,
          input.oldSubscriptionId,
          input.newPlanId,
          input.newSubscriptionId,
          input.planUpdateSignature,
          input.planCreationSignature,
          input.authorizationSetupSignature,
          input.authorizationSignature,
          input.oldCancelSignature,
          toPostgresTextArray(input.changedFields),
          JSON.stringify(input.beforeValues),
          JSON.stringify(input.afterValues),
          input.error,
          input.createdBy,
          input.createdAt,
          input.updatedAt
        )
        .run();

      return getUpdateAttemptByIdInternal(db, {
        attemptId: input.id,
        organizationId: input.organizationId,
        projectId: input.projectId,
      });
    },

    async updateUpdateAttempt(input: UpdatePaymentRecurringPaymentUpdateAttemptInput) {
      const row = await db
        .prepare(
          `UPDATE payment_recurring_payment_update_attempts
              SET status = COALESCE(?, status),
                  stage = COALESCE(?, stage),
                  new_plan_id = CASE WHEN ?::boolean THEN ? ELSE new_plan_id END,
                  new_subscription_id =
                    CASE WHEN ?::boolean THEN ? ELSE new_subscription_id END,
                  plan_update_signature =
                    CASE WHEN ?::boolean THEN ? ELSE plan_update_signature END,
                  plan_creation_signature =
                    CASE WHEN ?::boolean THEN ? ELSE plan_creation_signature END,
                  authorization_setup_signature =
                    CASE WHEN ?::boolean THEN ? ELSE authorization_setup_signature END,
                  authorization_signature =
                    CASE WHEN ?::boolean THEN ? ELSE authorization_signature END,
                  old_cancel_signature =
                    CASE WHEN ?::boolean THEN ? ELSE old_cancel_signature END,
                  changed_fields =
                    CASE WHEN ?::boolean THEN ?::text[] ELSE changed_fields END,
                  before_values =
                    CASE WHEN ?::boolean THEN ?::jsonb ELSE before_values END,
                  after_values =
                    CASE WHEN ?::boolean THEN ?::jsonb ELSE after_values END,
                  error = CASE WHEN ?::boolean THEN ? ELSE error END,
                  updated_at = ?
            WHERE id = ?
              AND organization_id = ?
              AND project_id = ?
          RETURNING *`
        )
        .bind(
          input.status === undefined ? null : input.status,
          input.stage === undefined ? null : input.stage,
          input.newPlanId !== undefined,
          input.newPlanId ?? null,
          input.newSubscriptionId !== undefined,
          input.newSubscriptionId ?? null,
          input.planUpdateSignature !== undefined,
          input.planUpdateSignature ?? null,
          input.planCreationSignature !== undefined,
          input.planCreationSignature ?? null,
          input.authorizationSetupSignature !== undefined,
          input.authorizationSetupSignature ?? null,
          input.authorizationSignature !== undefined,
          input.authorizationSignature ?? null,
          input.oldCancelSignature !== undefined,
          input.oldCancelSignature ?? null,
          input.changedFields !== undefined,
          input.changedFields === undefined ? null : toPostgresTextArray(input.changedFields),
          input.beforeValues !== undefined,
          input.beforeValues === undefined ? null : JSON.stringify(input.beforeValues),
          input.afterValues !== undefined,
          input.afterValues === undefined ? null : JSON.stringify(input.afterValues),
          input.error !== undefined,
          input.error ?? null,
          input.updatedAt,
          input.attemptId,
          input.organizationId,
          input.projectId
        )
        .first<Record<string, unknown>>();

      return row ? mapUpdateAttemptRow(row) : null;
    },

    async getLatestUpdateAttempt(input: GetLatestPaymentRecurringPaymentUpdateAttemptInput) {
      const clauses = ["organization_id = ?", "project_id = ?", "recurring_payment_id = ?"];
      const values: DatabaseBindValues = [
        input.organizationId,
        input.projectId,
        input.recurringPaymentId,
      ];
      if (input.statuses?.length) {
        clauses.push("status = ANY(?::text[])");
        values.push([...input.statuses]);
      }

      const row = await db
        .prepare(
          `SELECT *
             FROM payment_recurring_payment_update_attempts
            WHERE ${clauses.join(" AND ")}
            ORDER BY created_at DESC, updated_at DESC, id DESC
            LIMIT 1`
        )
        .bind(...values)
        .first<Record<string, unknown>>();

      return row ? mapUpdateAttemptRow(row) : null;
    },

    async createUpdateEvent(input: CreatePaymentRecurringPaymentUpdateEventInput) {
      await db
        .prepare(
          `INSERT INTO payment_recurring_payment_update_events (
             id,
             organization_id,
             project_id,
             recurring_payment_id,
             attempt_id,
             changed_fields,
             before_values,
             after_values,
             created_by,
             created_at
           ) VALUES (?, ?, ?, ?, ?, ?::text[], ?::jsonb, ?::jsonb, ?, ?)`
        )
        .bind(
          input.id,
          input.organizationId,
          input.projectId,
          input.recurringPaymentId,
          input.attemptId,
          toPostgresTextArray(input.changedFields),
          JSON.stringify(input.beforeValues),
          JSON.stringify(input.afterValues),
          input.createdBy,
          input.createdAt
        )
        .run();

      return getUpdateEventByIdInternal(db, {
        eventId: input.id,
        organizationId: input.organizationId,
        projectId: input.projectId,
      });
    },

    async getRecurringPaymentById(params) {
      const clauses = ["id = ?", "organization_id = ?", "project_id = ?"];
      const values: DatabaseBindValues = [
        params.recurringPaymentId,
        params.organizationId,
        params.projectId,
      ];

      addWalletAuthorization(clauses, values, params.walletAuthorization);

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
      const values: DatabaseBindValues = [params.organizationId, params.projectId];

      if (params.status) {
        clauses.push("status = ?");
        values.push(params.status);
      }
      if (params.counterpartyId) {
        clauses.push("counterparty_id = ?");
        values.push(params.counterpartyId);
      }
      addWalletAuthorization(clauses, values, params.walletAuthorization);

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

      if (countRow === null) {
        throw new AppError("INTERNAL_ERROR", "Recurring payment count query returned no row");
      }
      return {
        rows: rows.results.map(mapRecurringPaymentRow),
        total: countRow.total,
      } satisfies ListPaymentRecurringPaymentsResult;
    },
  };
}
