import {
  COLLECTION_ATTEMPT_STATUSES_BLOCKING_NEW_CYCLE,
  COLLECTION_ATTEMPT_STATUSES_WITH_SUBMITTED_TRANSFER,
  LIVE_RECURRING_PAYMENT_STATUSES,
  PAYMENT_RECURRING_PAYMENT_ACTIVATION_ATTEMPT_STAGES,
  PAYMENT_RECURRING_PAYMENT_ATTEMPT_STATUSES,
  PAYMENT_RECURRING_PAYMENT_LIFECYCLE_ATTEMPT_STAGES,
  PAYMENT_RECURRING_PAYMENT_LIFECYCLE_OPERATIONS,
  PAYMENT_RECURRING_PAYMENT_STATUSES,
  PAYMENT_RECURRING_PAYMENT_UPDATE_ATTEMPT_MODES,
  PAYMENT_RECURRING_PAYMENT_UPDATE_ATTEMPT_STAGES,
  RECURRING_PAYMENT_ATTEMPT_STATUSES_ANSWERING_IDEMPOTENCY_KEY,
  RECURRING_PAYMENT_LIFECYCLE_TRANSITIONS,
  RECURRING_PAYMENT_STATUSES_RECOVERABLE_BY_CRON,
  RECURRING_PAYMENT_STATUSES_WITH_RECOVERABLE_COLLECTION,
} from "@sdp/types/payments";
import { z } from "zod";
import type { DatabaseExecutor } from "@/db/client";
import { AppError } from "@/lib/errors";
import type {
  ClaimPaymentRecurringPaymentLifecycleInput,
  ClaimPaymentRecurringPaymentUpdateInput,
  ClearPaymentRecurringPaymentStepSignatureInput,
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
  RecoverableCollectionRecurringPaymentRow,
  RecurringPaymentActivator,
  RecurringPaymentStepSignatureSlot,
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

/** Records who activated a recurring payment; a null activator keeps what is stored. */
const ACTIVATED_BY_ASSIGNMENTS = `activated_by_api_key_id =
                    CASE WHEN ?::boolean THEN ?::text ELSE activated_by_api_key_id END,
                  activated_by_user_id =
                    CASE WHEN ?::boolean THEN ?::text ELSE activated_by_user_id END`;

function activatedByBindings(activatedBy: RecurringPaymentActivator | null) {
  const record = activatedBy !== null;
  return [record, activatedBy?.apiKeyId ?? null, record, activatedBy?.userId ?? null] as const;
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
  authorization_setup_signature: z.string().nullable(),
  authorization_signature: z.string().nullable(),
  last_valid_block_height: z.string().nullable(),
  error: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()),
  created_at: z.string(),
  updated_at: z.string(),
  idempotency_key: z.string().nullable(),
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
  last_valid_block_height: z.string().nullable(),
  error: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()),
  created_at: z.string(),
  updated_at: z.string(),
  idempotency_key: z.string().nullable(),
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
  last_valid_block_height: z.string().nullable(),
  changed_fields: z.array(z.string()),
  before_values: z.record(z.string(), z.unknown()),
  after_values: z.record(z.string(), z.unknown()),
  error: z.string().nullable(),
  created_by: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  idempotency_fingerprint: z.string().nullable(),
  idempotency_key: z.string().nullable(),
  previous_activator: z
    .object({ apiKeyId: z.string().nullable(), userId: z.string().nullable() })
    .nullable(),
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

const recoverableCollectionRecurringPaymentProjectionSchema = z.object({
  status: z.enum(RECURRING_PAYMENT_STATUSES_WITH_RECOVERABLE_COLLECTION),
  subscription_id: z.string(),
  next_collection_due_at: z.string(),
});

function mapRecoverableCollectionRecurringPaymentRow(
  row: Record<string, unknown>
): RecoverableCollectionRecurringPaymentRow {
  const recurringPayment = mapRecurringPaymentRow(row);
  const projection = recoverableCollectionRecurringPaymentProjectionSchema.parse(recurringPayment);
  return { ...recurringPayment, ...projection };
}

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

const STEP_SIGNATURE_TABLES = {
  recurring_payment: "payment_recurring_payments",
  activation_attempt: "payment_recurring_payment_activation_attempts",
  update_attempt: "payment_recurring_payment_update_attempts",
  lifecycle_attempt: "payment_recurring_payment_lifecycle_attempts",
} as const satisfies Record<RecurringPaymentStepSignatureSlot["row"], string>;

export function createPostgresPaymentRecurringPaymentsRepository(
  db: DatabaseExecutor
): PaymentRecurringPaymentsRepository {
  return {
    async listStaleLifecyclePayments({ environment, staleBefore, limit }) {
      const result = await db
        .prepare(
          `SELECT rp.* FROM payment_recurring_payments rp
           JOIN projects p ON p.id = rp.project_id
          WHERE p.environment = ?
            AND rp.status = ANY(?::text[])
            AND rp.updated_at <= ? ORDER BY rp.updated_at ASC LIMIT ?`
        )
        .bind(environment, [...RECURRING_PAYMENT_STATUSES_RECOVERABLE_BY_CRON], staleBefore, limit)
        .all<Record<string, unknown>>();
      return result.rows.map(mapRecurringPaymentRow);
    },
    async listStaleUpdatePayments({ environment, staleBefore, limit }) {
      const result = await db
        .prepare(
          `SELECT rp.organization_id, rp.project_id, rp.id, rp.updated_at,
                COUNT(*) OVER () AS stale_count, MIN(rp.updated_at) OVER () AS oldest_updated_at
           FROM payment_recurring_payments rp JOIN projects p ON p.id = rp.project_id
          WHERE p.environment = ? AND rp.status = 'updating' AND rp.updated_at <= ?
          ORDER BY rp.updated_at DESC, rp.id DESC LIMIT ?`
        )
        .bind(environment, staleBefore, limit)
        .all<Record<string, unknown>>();
      return result.rows.map(
        (row): StalePaymentRecurringPaymentUpdateRow => staleUpdateRowSchema.parse(row)
      );
    },
    async listRecoverableCollectionPayments({ environment, staleBefore, limit }) {
      const result = await db
        .prepare(
          `SELECT * FROM (
           SELECT rp.*, a.updated_at AS attempt_updated_at,
                  ROW_NUMBER() OVER (PARTITION BY rp.id ORDER BY CASE WHEN a.status = 'confirmed' THEN 0 ELSE 1 END, a.updated_at ASC) AS attempt_rank
             FROM payment_recurring_payments rp
             JOIN payment_subscription_collection_attempts a
               ON a.organization_id = rp.organization_id AND a.project_id = rp.project_id
              AND a.subscription_id = rp.subscription_id AND a.due_at = rp.next_collection_due_at
             JOIN projects p ON p.id = rp.project_id
            WHERE p.environment = ?
              AND rp.status = ANY(?::text[])
              AND rp.next_collection_due_at IS NOT NULL
              AND a.status = ANY(?::text[])
              AND ((a.status = 'processing' AND a.updated_at <= ?) OR (rp.status = 'active' AND a.status = 'confirmed'))
         ) recoverable_attempts WHERE attempt_rank = 1 ORDER BY attempt_updated_at ASC LIMIT ?`
        )
        .bind(
          environment,
          [...RECURRING_PAYMENT_STATUSES_WITH_RECOVERABLE_COLLECTION],
          [...COLLECTION_ATTEMPT_STATUSES_WITH_SUBMITTED_TRANSFER],
          staleBefore,
          limit
        )
        .all<Record<string, unknown>>();
      return result.rows.map(mapRecoverableCollectionRecurringPaymentRow);
    },
    async listDueCollectionPayments({ environment, dueBefore, retryBefore, limit }) {
      const result = await db
        .prepare(
          `SELECT rp.* FROM payment_recurring_payments rp
           JOIN projects p ON p.id = rp.project_id
          WHERE p.environment = ? AND rp.status = 'active' AND rp.next_collection_due_at IS NOT NULL AND rp.next_collection_due_at <= ?
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
        .bind(
          environment,
          dueBefore,
          [...COLLECTION_ATTEMPT_STATUSES_BLOCKING_NEW_CYCLE],
          retryBefore,
          limit
        )
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
             updated_at,
             idempotency_key,
             idempotency_fingerprint
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
          input.updatedAt,
          input.idempotencyKey,
          input.idempotencyFingerprint
        )
        .run();

      return getRecurringPaymentByIdInternal(db, {
        recurringPaymentId: input.id,
        organizationId: input.organizationId,
        projectId: input.projectId,
      });
    },

    async findRecurringPaymentByIdempotencyKey({ organizationId, projectId, idempotencyKey }) {
      const row = await db
        .prepare(
          `SELECT id, idempotency_fingerprint
             FROM payment_recurring_payments
            WHERE organization_id = ? AND project_id = ? AND idempotency_key = ?`
        )
        .bind(organizationId, projectId, idempotencyKey)
        .first<{ id: string; idempotency_fingerprint: string | null }>();
      return row === null
        ? null
        : { id: row.id, idempotencyFingerprint: row.idempotency_fingerprint };
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

    async lockRecurringPaymentActivator(params) {
      const row = await db
        .prepare(
          `SELECT activated_by_api_key_id, activated_by_user_id
             FROM payment_recurring_payments
            WHERE id = ? AND organization_id = ? AND project_id = ?
            FOR UPDATE`
        )
        .bind(params.recurringPaymentId, params.organizationId, params.projectId)
        .first<{ activated_by_api_key_id: string | null; activated_by_user_id: string | null }>();
      return row
        ? { apiKeyId: row.activated_by_api_key_id, userId: row.activated_by_user_id }
        : null;
    },

    async restoreRecurringPaymentActivator(params) {
      await db
        .prepare(
          `UPDATE payment_recurring_payments
              SET activated_by_api_key_id = ?, activated_by_user_id = ?
            WHERE id = ? AND organization_id = ? AND project_id = ?`
        )
        .bind(
          params.activator.apiKeyId,
          params.activator.userId,
          params.recurringPaymentId,
          params.organizationId,
          params.projectId
        )
        .run();
    },

    async claimRecurringPaymentActivation(params) {
      const staleBefore = params.staleBefore ?? null;
      const row = await db
        .prepare(
          `UPDATE payment_recurring_payments
              SET status = 'activating',
                  updated_at = ?,
                  ${ACTIVATED_BY_ASSIGNMENTS}
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
          ...activatedByBindings(params.activatedBy),
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
          // A row back in pending_activation was never activated, so it has
          // no activator: a refused or failed claim leaves none behind.
          `UPDATE payment_recurring_payments
              SET status = 'pending_activation',
                  updated_at = ?,
                  activated_by_api_key_id = NULL,
                  activated_by_user_id = NULL
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
                  updated_at = ?,
                  ${ACTIVATED_BY_ASSIGNMENTS}
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
          ...activatedByBindings(input.activatedBy),
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
                  updated_at = ?,
                  ${ACTIVATED_BY_ASSIGNMENTS}
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
          ...activatedByBindings(input.activatedBy),
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
             updated_at,
             idempotency_key
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?, ?)`
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
          input.updatedAt,
          input.idempotencyKey ?? null
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
                  authorization_setup_signature =
                    CASE WHEN ?::boolean THEN ? ELSE authorization_setup_signature END,
                  authorization_signature =
                    CASE WHEN ?::boolean THEN ? ELSE authorization_signature END,
                  last_valid_block_height =
                    CASE WHEN ?::boolean THEN ?::numeric ELSE last_valid_block_height END,
                  error = CASE WHEN ?::boolean THEN ? ELSE error END,
                  metadata = CASE WHEN ?::boolean THEN ?::jsonb ELSE metadata END,
                  idempotency_key = COALESCE(idempotency_key, ?),
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
          input.authorizationSetupSignature !== undefined,
          input.authorizationSetupSignature ?? null,
          input.authorizationSignature !== undefined,
          input.authorizationSignature ?? null,
          input.lastValidBlockHeight !== undefined,
          input.lastValidBlockHeight ?? null,
          input.error !== undefined,
          input.error ?? null,
          input.metadata !== undefined,
          input.metadata === undefined ? null : JSON.stringify(input.metadata),
          input.adoptIdempotencyKey ?? null,
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

    async findActivationAttemptByIdempotencyKey(input) {
      const row = await db
        .prepare(
          `SELECT *
             FROM payment_recurring_payment_activation_attempts
            WHERE organization_id = ?
              AND project_id = ?
              AND idempotency_key = ?
              AND status = ANY(?::text[])
            ORDER BY created_at DESC, id DESC
            LIMIT 1`
        )
        .bind(input.organizationId, input.projectId, input.idempotencyKey, [
          ...RECURRING_PAYMENT_ATTEMPT_STATUSES_ANSWERING_IDEMPOTENCY_KEY,
        ])
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
             updated_at,
             idempotency_key
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?, ?)`
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
          input.updatedAt,
          input.idempotencyKey ?? null
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
                  last_valid_block_height =
                    CASE WHEN ?::boolean THEN ?::numeric ELSE last_valid_block_height END,
                  error = CASE WHEN ?::boolean THEN ? ELSE error END,
                  metadata = CASE WHEN ?::boolean THEN ?::jsonb ELSE metadata END,
                  idempotency_key = COALESCE(idempotency_key, ?),
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
          input.lastValidBlockHeight !== undefined,
          input.lastValidBlockHeight ?? null,
          input.error !== undefined,
          input.error ?? null,
          input.metadata !== undefined,
          input.metadata === undefined ? null : JSON.stringify(input.metadata),
          input.adoptIdempotencyKey ?? null,
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

    async findLifecycleAttemptByIdempotencyKey(input) {
      const row = await db
        .prepare(
          `SELECT *
             FROM payment_recurring_payment_lifecycle_attempts
            WHERE organization_id = ?
              AND project_id = ?
              AND operation = ?
              AND idempotency_key = ?
              AND status = ANY(?::text[])
            ORDER BY created_at DESC, id DESC
            LIMIT 1`
        )
        .bind(input.organizationId, input.projectId, input.operation, input.idempotencyKey, [
          ...RECURRING_PAYMENT_ATTEMPT_STATUSES_ANSWERING_IDEMPOTENCY_KEY,
        ])
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
             updated_at,
             idempotency_key,
             idempotency_fingerprint,
             previous_activator
           ) VALUES (
             ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
             ?::text[], ?::jsonb, ?::jsonb, ?, ?, ?, ?, ?, ?, ?::jsonb
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
          input.updatedAt,
          input.idempotencyKey ?? null,
          input.idempotencyFingerprint ?? null,
          input.previousActivator ? JSON.stringify(input.previousActivator) : null
        )
        .run();

      return getUpdateAttemptByIdInternal(db, {
        attemptId: input.id,
        organizationId: input.organizationId,
        projectId: input.projectId,
      });
    },

    async clearStepSignature(input: ClearPaymentRecurringPaymentStepSignatureInput) {
      const table = STEP_SIGNATURE_TABLES[input.slot.row];
      const { column } = input.slot;
      // Table and column come from the typed slot, never from caller text. Only attempt rows keep
      // the block height, and it belongs to the one step in flight.
      const assignment =
        input.slot.row === "recurring_payment"
          ? `${column} = NULL`
          : `${column} = NULL, last_valid_block_height = NULL`;
      const rowsAffected = await db
        .prepare(
          `UPDATE ${table}
              SET ${assignment},
                  updated_at = ?
            WHERE id = ?
              AND organization_id = ?
              AND project_id = ?
              AND ${column} = ?`
        )
        .bind(input.updatedAt, input.id, input.organizationId, input.projectId, input.signature)
        .run();
      return rowsAffected > 0;
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
                  last_valid_block_height =
                    CASE WHEN ?::boolean THEN ?::numeric ELSE last_valid_block_height END,
                  changed_fields =
                    CASE WHEN ?::boolean THEN ?::text[] ELSE changed_fields END,
                  before_values =
                    CASE WHEN ?::boolean THEN ?::jsonb ELSE before_values END,
                  after_values =
                    CASE WHEN ?::boolean THEN ?::jsonb ELSE after_values END,
                  error = CASE WHEN ?::boolean THEN ? ELSE error END,
                  -- Both read the row as it was: the fingerprint is adopted with the key.
                  idempotency_fingerprint = CASE WHEN idempotency_key IS NULL
                    THEN COALESCE(?, idempotency_fingerprint) ELSE idempotency_fingerprint END,
                  idempotency_key = COALESCE(idempotency_key, ?),
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
          input.lastValidBlockHeight !== undefined,
          input.lastValidBlockHeight ?? null,
          input.changedFields !== undefined,
          input.changedFields === undefined ? null : toPostgresTextArray(input.changedFields),
          input.beforeValues !== undefined,
          input.beforeValues === undefined ? null : JSON.stringify(input.beforeValues),
          input.afterValues !== undefined,
          input.afterValues === undefined ? null : JSON.stringify(input.afterValues),
          input.error !== undefined,
          input.error ?? null,
          input.adoptIdempotencyFingerprint ?? null,
          input.adoptIdempotencyKey ?? null,
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

    async findUpdateAttemptByIdempotencyKey(input) {
      const row = await db
        .prepare(
          `SELECT *
             FROM payment_recurring_payment_update_attempts
            WHERE organization_id = ?
              AND project_id = ?
              AND idempotency_key = ?
              AND status = ANY(?::text[])
            ORDER BY created_at DESC, id DESC
            LIMIT 1`
        )
        .bind(input.organizationId, input.projectId, input.idempotencyKey, [
          ...RECURRING_PAYMENT_ATTEMPT_STATUSES_ANSWERING_IDEMPOTENCY_KEY,
        ])
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

    async listLiveRecurringPaymentsActivatedByApiKey(params) {
      const rows = await db
        .prepare(
          // The key and every predecessor it was rotated from, in this project.
          `WITH RECURSIVE lineage(id, rotated_from) AS (
             SELECT id, rotated_from FROM api_keys
              WHERE id = ? AND organization_id = ? AND project_id = ?
             UNION
             SELECT ak.id, ak.rotated_from
               FROM api_keys ak
               JOIN lineage ON ak.id = lineage.rotated_from
              WHERE ak.organization_id = ? AND ak.project_id = ?
           )
           SELECT rp.*
             FROM payment_recurring_payments rp
            WHERE rp.organization_id = ?
              AND rp.project_id = ?
              AND (
                rp.activated_by_api_key_id IN (SELECT id FROM lineage)
                -- An update in flight already names its caller, and puts the
                -- key it replaced back if it fails: that key still answers
                -- for the payment until the update lands.
                OR (rp.status = 'updating' AND EXISTS (
                  SELECT 1 FROM payment_recurring_payment_update_attempts a
                   WHERE a.recurring_payment_id = rp.id
                     AND a.organization_id = rp.organization_id
                     AND a.project_id = rp.project_id
                     AND a.status = 'processing'
                     AND a.previous_activator->>'apiKeyId' IN (SELECT id FROM lineage)
                ))
              )
              AND rp.status = ANY(?::text[])
            ORDER BY rp.created_at ASC`
        )
        .bind(
          params.apiKeyId,
          params.organizationId,
          params.projectId,
          params.organizationId,
          params.projectId,
          params.organizationId,
          params.projectId,
          [...LIVE_RECURRING_PAYMENT_STATUSES]
        )
        .all<Record<string, unknown>>();
      return rows.results.map(mapRecurringPaymentRow);
    },

    async getRecurringPaymentById(params) {
      const clauses = ["id = ?", "organization_id = ?", "project_id = ?"];
      const values: DatabaseBindValues = [
        params.recurringPaymentId,
        params.organizationId,
        params.projectId,
      ];

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
