import { getDb } from "@/db";
import type { PaymentRecurringPaymentRow } from "@/db/repositories";
import { AppError } from "@/lib/errors";
import { createSigningService } from "@/services/domain/signing.service";
import {
  DEFAULT_RECURRING_COLLECTION_RETRY_AFTER_MINUTES,
  parsePositiveIntegerConfig,
} from "@/services/payments/recurring-payment-config";
import {
  activateRecurringPayment,
  cancelRecurringPayment,
  collectRecurringPayment,
  resumeRecurringPayment,
} from "@/services/payments/recurring-payments";
import type { CustodyWallet } from "@/services/stores/custody-config.store";
import type { Env } from "@/types/env";

const DEFAULT_BATCH_SIZE = 25;
const MAX_BATCH_SIZE = 100;
const STALE_AFTER_MS = 15 * 60 * 1000;

export interface CollectDueRecurringPaymentsResult {
  recovered: number;
  collected: number;
  failed: number;
  skipped: number;
}

function batchSize(env: Env): number {
  return Math.min(
    parsePositiveIntegerConfig(env.PAYMENTS_RECURRING_COLLECTION_BATCH_SIZE, DEFAULT_BATCH_SIZE),
    MAX_BATCH_SIZE
  );
}

function retryAfterMinutes(env: Env): number {
  return parsePositiveIntegerConfig(
    env.PAYMENTS_RECURRING_COLLECTION_RETRY_AFTER_MINUTES,
    DEFAULT_RECURRING_COLLECTION_RETRY_AFTER_MINUTES
  );
}

function emptyResult(): CollectDueRecurringPaymentsResult {
  return { recovered: 0, collected: 0, failed: 0, skipped: 0 };
}

async function rowsForQuery(
  env: Env,
  query: string,
  ...bindings: Array<string | number>
): Promise<PaymentRecurringPaymentRow[]> {
  const result = await getDb(env)
    .prepare(query)
    .bind(...bindings)
    .all<PaymentRecurringPaymentRow>();
  return result.rows;
}

async function resolveSourceWallet(
  env: Env,
  row: PaymentRecurringPaymentRow
): Promise<CustodyWallet | null> {
  const wallet = await createSigningService(env).getWalletById(
    row.organization_id,
    row.project_id,
    row.source_wallet_id
  );
  if (!wallet || wallet.publicKey !== row.source_address) {
    return null;
  }
  return wallet;
}

function shouldSkipCollectionError(error: unknown): boolean {
  return error instanceof AppError && error.code === "CONFLICT";
}

function logCronFailure(message: string, row: PaymentRecurringPaymentRow, error: unknown): void {
  console.error(message, {
    error: error instanceof Error ? error.message : String(error),
    organizationId: row.organization_id,
    projectId: row.project_id,
    recurringPaymentId: row.id,
  });
}

async function collectRow(
  env: Env,
  row: PaymentRecurringPaymentRow
): Promise<"ok" | "failed" | "skipped"> {
  try {
    const sourceWallet = await resolveSourceWallet(env, row);
    if (!sourceWallet) {
      return "failed";
    }
    await collectRecurringPayment({
      env,
      organizationId: row.organization_id,
      projectId: row.project_id,
      sourceWallet,
      recurringPayment: row,
      initiatedByKeyId: null,
      collectionSource: "automated",
    });
    return "ok";
  } catch (error) {
    if (shouldSkipCollectionError(error)) {
      return "skipped";
    }
    logCronFailure("collectDueRecurringPayments: failed to collect recurring payment", row, error);
    return "failed";
  }
}

async function recoverLifecycleRow(
  env: Env,
  row: PaymentRecurringPaymentRow
): Promise<"ok" | "failed" | "skipped"> {
  try {
    const sourceWallet = await resolveSourceWallet(env, row);
    if (!sourceWallet) {
      return "failed";
    }
    if (row.status === "activating") {
      await activateRecurringPayment({
        env,
        organizationId: row.organization_id,
        projectId: row.project_id,
        sourceWallet,
        recurringPayment: row,
        createdBy: row.created_by,
      });
      return "ok";
    }
    if (row.status === "canceling") {
      await cancelRecurringPayment({
        env,
        organizationId: row.organization_id,
        projectId: row.project_id,
        sourceWallet,
        recurringPayment: row,
      });
      return "ok";
    }
    if (row.status === "resuming") {
      await resumeRecurringPayment({
        env,
        organizationId: row.organization_id,
        projectId: row.project_id,
        sourceWallet,
        recurringPayment: row,
      });
      return "ok";
    }
    return "skipped";
  } catch (error) {
    if (shouldSkipCollectionError(error)) {
      return "skipped";
    }
    logCronFailure(
      "collectDueRecurringPayments: failed to recover recurring payment operation",
      row,
      error
    );
    return "failed";
  }
}

function addOutcome(
  result: CollectDueRecurringPaymentsResult,
  outcome: "ok" | "failed" | "skipped",
  okKey: "recovered" | "collected"
): void {
  if (outcome === "ok") {
    result[okKey] += 1;
    return;
  }
  if (outcome === "skipped") {
    result.skipped += 1;
    return;
  }
  result.failed += 1;
}

export async function collectDueRecurringPayments(
  env: Env,
  now = new Date()
): Promise<CollectDueRecurringPaymentsResult> {
  const result = emptyResult();
  const limit = batchSize(env);
  const dueBefore = now.toISOString();
  const staleBefore = new Date(now.getTime() - STALE_AFTER_MS).toISOString();
  const retryBefore = new Date(now.getTime() - retryAfterMinutes(env) * 60 * 1000).toISOString();

  const staleLifecyclePayments = await rowsForQuery(
    env,
    `SELECT *
       FROM payment_recurring_payments
      WHERE status IN ('activating', 'canceling', 'resuming')
        AND updated_at <= ?
      ORDER BY updated_at ASC
      LIMIT ?`,
    staleBefore,
    limit
  );
  for (const row of staleLifecyclePayments) {
    addOutcome(result, await recoverLifecycleRow(env, row), "recovered");
  }

  const staleCollectionPayments = await rowsForQuery(
    env,
    `SELECT *
       FROM (
         SELECT
           rp.*,
           a.updated_at AS attempt_updated_at,
           ROW_NUMBER() OVER (
             PARTITION BY rp.id
             ORDER BY
               CASE WHEN a.status = 'confirmed' THEN 0 ELSE 1 END,
               a.updated_at ASC
           ) AS attempt_rank
         FROM payment_recurring_payments rp
         JOIN payment_subscription_collection_attempts a
           ON a.organization_id = rp.organization_id
          AND a.project_id = rp.project_id
          AND a.subscription_id = rp.subscription_id
          AND a.due_at = rp.next_collection_due_at
        WHERE rp.status = 'active'
          AND rp.next_collection_due_at IS NOT NULL
          AND a.status IN ('processing', 'confirmed')
          AND (a.status = 'confirmed' OR a.updated_at <= ?)
       ) recoverable_attempts
      WHERE attempt_rank = 1
      ORDER BY attempt_updated_at ASC
      LIMIT ?`,
    staleBefore,
    limit
  );
  for (const row of staleCollectionPayments) {
    addOutcome(result, await collectRow(env, row), "recovered");
  }

  const duePayments = await rowsForQuery(
    env,
    `SELECT rp.*
       FROM payment_recurring_payments rp
      WHERE rp.status = 'active'
        AND rp.next_collection_due_at IS NOT NULL
        AND rp.next_collection_due_at <= ?
        AND NOT EXISTS (
          SELECT 1
            FROM payment_subscription_collection_attempts active_attempt
           WHERE active_attempt.organization_id = rp.organization_id
             AND active_attempt.project_id = rp.project_id
             AND active_attempt.subscription_id = rp.subscription_id
             AND active_attempt.due_at = rp.next_collection_due_at
             AND active_attempt.status IN ('pending', 'processing', 'confirmed')
        )
        AND NOT EXISTS (
          SELECT 1
            FROM payment_subscription_collection_attempts failed_attempt
           WHERE failed_attempt.organization_id = rp.organization_id
             AND failed_attempt.project_id = rp.project_id
             AND failed_attempt.subscription_id = rp.subscription_id
             AND failed_attempt.due_at = rp.next_collection_due_at
             AND failed_attempt.status = 'failed'
             AND failed_attempt.updated_at > ?
        )
      ORDER BY rp.next_collection_due_at ASC
      LIMIT ?`,
    dueBefore,
    retryBefore,
    limit
  );
  for (const row of duePayments) {
    addOutcome(result, await collectRow(env, row), "collected");
  }

  return result;
}
