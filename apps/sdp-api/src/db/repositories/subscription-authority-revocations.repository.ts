import { SDP_ENVIRONMENTS, type SdpEnvironment } from "@sdp/types/api-keys";
import {
  IN_FLIGHT_RECURRING_PAYMENT_ATTEMPT_STATUSES,
  PAYMENT_SUBSCRIPTION_STATUSES_AWAITING_AUTHORIZATION,
  PAYMENT_SUBSCRIPTION_STATUSES_RELEASING_AUTHORITY,
  RECURRING_PAYMENT_STATUSES_CLAIMING_AUTHORITY,
  RECURRING_PAYMENT_STATUSES_RELEASING_AUTHORITY,
  SUBSCRIPTION_AUTHORITY_REVOCATION_HOLDING_STATUSES,
  SUBSCRIPTION_AUTHORITY_REVOCATION_STATUSES,
  type SubscriptionAuthorityRevocationStatus,
} from "@sdp/types/payments";
import { z } from "zod";
import type { DatabaseExecutor } from "@/db/client";

/**
 * Revokes of a wallet's per-mint Subscriptions authority (HOO-2210, migration 0153). The
 * revoke-subscription-authorities cron is the only writer; activation, update and resume only read
 * whether one holds their wallet.
 */

/**
 * How long after a subscription's or recurring payment's last change its authority stays: one
 * billing period plus this margin. Cancel ends a subscription at the end of its current period, at
 * most one period after the cancel, and resume needs the authority until then.
 */
export const SUBSCRIPTION_AUTHORITY_IDLE_MARGIN_HOURS = 1;

const revocationRowSchema = z.object({
  id: z.string(),
  organization_id: z.string(),
  project_id: z.string(),
  environment: z.enum(SDP_ENVIRONMENTS),
  custody_wallet_id: z.string(),
  wallet_address: z.string(),
  token_mint: z.string(),
  subscription_authority_address: z.string(),
  status: z.enum(SUBSCRIPTION_AUTHORITY_REVOCATION_STATUSES),
  lease_id: z.string(),
  signature: z.string().nullable(),
  last_valid_block_height: z.coerce.string().nullable(),
  error: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

export type SubscriptionAuthorityRevocationRow = z.infer<typeof revocationRowSchema>;

const candidateRowSchema = z.object({
  organization_id: z.string(),
  project_id: z.string(),
  custody_wallet_id: z.string(),
  wallet_address: z.string(),
  token: z.string(),
  subscription_authority_address: z.string(),
});

/** An authority nothing needs any more, and the custody wallet that signs its revoke. */
export type RevocableSubscriptionAuthority = z.infer<typeof candidateRowSchema>;

/** The status sets the idle predicate binds, from `@sdp/types`. */
const STATUS_BINDINGS = [
  [...PAYMENT_SUBSCRIPTION_STATUSES_RELEASING_AUTHORITY],
  [...RECURRING_PAYMENT_STATUSES_RELEASING_AUTHORITY],
  [...RECURRING_PAYMENT_STATUSES_CLAIMING_AUTHORITY],
  [...IN_FLIGHT_RECURRING_PAYMENT_ATTEMPT_STATUSES],
  [...SUBSCRIPTION_AUTHORITY_REVOCATION_HOLDING_STATUSES],
  [...PAYMENT_SUBSCRIPTION_STATUSES_AWAITING_AUTHORIZATION],
] as const;

/** The `authority_ref` columns after its first five, bound in this order from STATUS_BINDINGS. */
const STATUS_COLUMNS = `?::text[] AS subscription_released, ?::text[] AS payment_released,
  ?::text[] AS payment_claiming, ?::text[] AS attempt_in_flight, ?::text[] AS revocation_holding,
  ?::text[] AS subscription_awaiting`;

/**
 * Whether `authority_ref.authority` has nothing left that needs it. `authority_ref` is a row the
 * query supplies: authority, wallet, environment, idle_before, retry_failed_before, then the
 * STATUS_COLUMNS.
 *
 * - Every subscription SDP recorded on it, in any project of the environment, is released (a
 *   recurring payment's earlier subscriptions included: an update that moves its wallet or token
 *   leaves the old one here), and its last change is more than its plan's period plus the margin
 *   ago, so none can still be resumed. A recurring payment's subscription still awaiting
 *   authorization counts as released once nothing can authorize it: no unreleased recurring
 *   payment names it and no update in flight is creating it. A failed activation or update leaves
 *   it so. A standalone subscription awaiting authorization always holds: its row stays pending
 *   after the caller's own authorization lands.
 * - Every recurring payment still on it is released and as long past its period.
 * - Nothing may be about to use one of the wallet's authorities before recording it: no recurring
 *   payment from the wallet is activating, updating or resuming, and no update in flight is moving
 *   a recurring payment onto the wallet.
 * - No revoke of it holds it, none failed within the retry window, and none has confirmed since
 *   the last change on it.
 */
const AUTHORITY_IDLE_PREDICATE = `
  NOT EXISTS (
    SELECT 1 FROM payment_subscriptions other
      JOIN projects other_project ON other_project.id = other.project_id
      JOIN payment_subscription_plans other_plan ON other_plan.id = other.plan_id
     WHERE other.subscription_authority_address = authority_ref.authority
       AND other_project.environment = authority_ref.environment
       AND ((other.status <> ALL(authority_ref.subscription_released)
             AND NOT (other.status = ANY(authority_ref.subscription_awaiting)
                      -- Only a recurring payment's own subscription: a standalone one stays
                      -- pending after its caller's authorization lands.
                      AND (EXISTS (SELECT 1 FROM payment_recurring_payments created_for
                                    WHERE created_for.subscription_id = other.id)
                           OR EXISTS (SELECT 1 FROM payment_recurring_payment_update_attempts created_by
                                       WHERE created_by.new_subscription_id = other.id))
                      AND NOT EXISTS (
                        SELECT 1 FROM payment_recurring_payments owner
                         WHERE owner.subscription_id = other.id
                           AND owner.status <> ALL(authority_ref.payment_released))
                      AND NOT EXISTS (
                        SELECT 1 FROM payment_recurring_payment_update_attempts creating
                         WHERE creating.new_subscription_id = other.id
                           AND creating.status = ANY(authority_ref.attempt_in_flight))))
            OR COALESCE(other.canceled_at, other.updated_at)::timestamptz
                 + make_interval(hours => other_plan.period_hours + ${SUBSCRIPTION_AUTHORITY_IDLE_MARGIN_HOURS})
               > authority_ref.idle_before::timestamptz))
  AND NOT EXISTS (
    SELECT 1 FROM payment_recurring_payments payment
      JOIN projects payment_project ON payment_project.id = payment.project_id
     WHERE payment.subscription_authority_address = authority_ref.authority
       AND payment_project.environment = authority_ref.environment
       AND (payment.status <> ALL(authority_ref.payment_released)
            OR payment.updated_at::timestamptz
                 + make_interval(hours => payment.period_hours + ${SUBSCRIPTION_AUTHORITY_IDLE_MARGIN_HOURS})
               > authority_ref.idle_before::timestamptz))
  AND NOT EXISTS (
    SELECT 1 FROM payment_recurring_payments claiming
      JOIN projects claiming_project ON claiming_project.id = claiming.project_id
     WHERE claiming.source_address = authority_ref.wallet
       AND claiming_project.environment = authority_ref.environment
       AND claiming.status = ANY(authority_ref.payment_claiming))
  AND NOT EXISTS (
    SELECT 1 FROM payment_recurring_payment_update_attempts moving
      JOIN custody_wallets destination ON destination.id = moving.new_source_custody_wallet_id
      JOIN projects moving_project ON moving_project.id = moving.project_id
     WHERE destination.public_key = authority_ref.wallet
       AND moving_project.environment = authority_ref.environment
       AND moving.status = ANY(authority_ref.attempt_in_flight))
  AND NOT EXISTS (
    SELECT 1 FROM payment_subscription_authority_revocations revocation
     WHERE revocation.environment = authority_ref.environment
       AND revocation.subscription_authority_address = authority_ref.authority
       AND (revocation.status = ANY(authority_ref.revocation_holding)
            OR (revocation.status = 'failed' AND revocation.updated_at > authority_ref.retry_failed_before)
            OR (revocation.status = 'confirmed'
                AND revocation.created_at >= GREATEST(
                  (SELECT max(changed.updated_at) FROM payment_subscriptions changed
                     JOIN projects changed_project ON changed_project.id = changed.project_id
                    WHERE changed.subscription_authority_address = authority_ref.authority
                      AND changed_project.environment = authority_ref.environment),
                  (SELECT max(changed.updated_at) FROM payment_recurring_payments changed
                     JOIN projects changed_project ON changed_project.id = changed.project_id
                    WHERE changed.subscription_authority_address = authority_ref.authority
                      AND changed_project.environment = authority_ref.environment)))))`;

export interface SubscriptionAuthorityRevocationsRepository {
  /**
   * Authorities the cron may revoke now, one row each: those of subscriptions whose subscriber is
   * an active custody wallet of the same project, signed for by that wallet.
   */
  listRevocableAuthorities(input: {
    environment: SdpEnvironment;
    idleBefore: string;
    retryFailedBefore: string;
    limit: number;
  }): Promise<RevocableSubscriptionAuthority[]>;
  /**
   * Holds the wallet's authorities until the transaction ends. The cron's claim and every
   * activation, update and resume claim on the wallet take it, so neither commits while the other
   * decides.
   */
  lockWalletAuthorities(walletAddress: string): Promise<void>;
  /** Whether a revoke holds any of the wallet's authorities. Call under the wallet's lock. */
  hasRevocationHolding(input: {
    environment: SdpEnvironment;
    walletAddress: string;
  }): Promise<boolean>;
  /**
   * Records a `processing` revoke of the authority, under `leaseId`, if it is still idle. Call
   * under the wallet's lock. Null when something now needs the authority or another revoke holds
   * it.
   */
  claimRevocation(input: {
    id: string;
    leaseId: string;
    organizationId: string;
    projectId: string;
    environment: SdpEnvironment;
    custodyWalletId: string;
    walletAddress: string;
    tokenMint: string;
    subscriptionAuthorityAddress: string;
    idleBefore: string;
    retryFailedBefore: string;
    now: string;
  }): Promise<SubscriptionAuthorityRevocationRow | null>;
  /** Saves the send before it is broadcast. Null when the caller no longer holds the lease. */
  saveSend(input: {
    id: string;
    leaseId: string;
    signature: string;
    lastValidBlockHeight: string;
    updatedAt: string;
  }): Promise<SubscriptionAuthorityRevocationRow | null>;
  /** Clears a saved send that provably never landed, only while the caller holds the lease. */
  clearSend(input: {
    id: string;
    leaseId: string;
    signature: string;
    updatedAt: string;
  }): Promise<boolean>;
  /** Ends a `processing` revoke. Null when the caller no longer holds the lease. */
  finish(input: {
    id: string;
    leaseId: string;
    status: Exclude<SubscriptionAuthorityRevocationStatus, "processing">;
    error: string | null;
    updatedAt: string;
  }): Promise<SubscriptionAuthorityRevocationRow | null>;
  /**
   * Takes over `processing` revokes last touched before `staleBefore`, each under a fresh lease,
   * so the run that held it can no longer change it.
   */
  claimStaleRevocations(input: {
    environment: SdpEnvironment;
    staleBefore: string;
    now: string;
    limit: number;
  }): Promise<SubscriptionAuthorityRevocationRow[]>;
}

export function createPostgresSubscriptionAuthorityRevocationsRepository(
  db: DatabaseExecutor
): SubscriptionAuthorityRevocationsRepository {
  return {
    async listRevocableAuthorities({ environment, idleBefore, retryFailedBefore, limit }) {
      const rows = await db.queryMany(
        `SELECT DISTINCT ON (s.subscription_authority_address)
                s.organization_id, s.project_id, w.id AS custody_wallet_id,
                s.subscriber_address AS wallet_address, plan.token,
                s.subscription_authority_address
           FROM payment_subscriptions s
           JOIN projects p ON p.id = s.project_id
           JOIN payment_subscription_plans plan ON plan.id = s.plan_id
           JOIN custody_wallets w ON w.public_key = s.subscriber_address AND w.status = 'active'
           LEFT JOIN custody_configs cfg ON cfg.id = w.custody_config_id
           LEFT JOIN custody_connections conn ON conn.id = w.custody_connection_id
          CROSS JOIN LATERAL (
            SELECT s.subscription_authority_address AS authority, s.subscriber_address AS wallet,
                   p.environment AS environment, ?::text AS idle_before,
                   ?::text AS retry_failed_before, ${STATUS_COLUMNS}
          ) authority_ref
          WHERE p.environment = ?
            AND s.subscription_authority_address IS NOT NULL
            AND (cfg.project_id = s.project_id OR conn.project_id = s.project_id)
            AND ${AUTHORITY_IDLE_PREDICATE}
          ORDER BY s.subscription_authority_address, s.updated_at DESC, w.id
          LIMIT ?`,
        [idleBefore, retryFailedBefore, ...STATUS_BINDINGS, environment, limit]
      );
      return rows.map((row) => candidateRowSchema.parse(row));
    },

    async lockWalletAuthorities(walletAddress) {
      await db.queryOne(
        "SELECT pg_advisory_xact_lock(hashtext('sdp:subscription-authority'), hashtext(?::text))",
        [walletAddress]
      );
    },

    async hasRevocationHolding({ environment, walletAddress }) {
      const row = await db.queryOne(
        `SELECT 1 AS holding FROM payment_subscription_authority_revocations
          WHERE environment = ? AND wallet_address = ? AND status = ANY(?::text[])
          LIMIT 1`,
        [environment, walletAddress, [...SUBSCRIPTION_AUTHORITY_REVOCATION_HOLDING_STATUSES]]
      );
      return row !== null;
    },

    async claimRevocation(input) {
      const row = await db.queryOne(
        `INSERT INTO payment_subscription_authority_revocations (
            id, organization_id, project_id, environment, custody_wallet_id, wallet_address,
            token_mint, subscription_authority_address, status, lease_id, created_at, updated_at)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, 'processing', ?, ?, ?
           FROM (SELECT ?::text AS authority, ?::text AS wallet, ?::text AS environment,
                        ?::text AS idle_before, ?::text AS retry_failed_before,
                        ${STATUS_COLUMNS}) authority_ref
          WHERE ${AUTHORITY_IDLE_PREDICATE}
         ON CONFLICT DO NOTHING
         RETURNING *`,
        [
          input.id,
          input.organizationId,
          input.projectId,
          input.environment,
          input.custodyWalletId,
          input.walletAddress,
          input.tokenMint,
          input.subscriptionAuthorityAddress,
          input.leaseId,
          input.now,
          input.now,
          input.subscriptionAuthorityAddress,
          input.walletAddress,
          input.environment,
          input.idleBefore,
          input.retryFailedBefore,
          ...STATUS_BINDINGS,
        ]
      );
      return row ? revocationRowSchema.parse(row) : null;
    },

    async saveSend({ id, leaseId, signature, lastValidBlockHeight, updatedAt }) {
      const row = await db.queryOne(
        `UPDATE payment_subscription_authority_revocations
            SET signature = ?, last_valid_block_height = ?::numeric, updated_at = ?
          WHERE id = ? AND lease_id = ? AND status = 'processing'
          RETURNING *`,
        [signature, lastValidBlockHeight, updatedAt, id, leaseId]
      );
      return row ? revocationRowSchema.parse(row) : null;
    },

    async clearSend({ id, leaseId, signature, updatedAt }) {
      const cleared = await db.execute(
        `UPDATE payment_subscription_authority_revocations
            SET signature = NULL, last_valid_block_height = NULL, updated_at = ?
          WHERE id = ? AND lease_id = ? AND status = 'processing' AND signature = ?`,
        [updatedAt, id, leaseId, signature]
      );
      return cleared > 0;
    },

    async finish({ id, leaseId, status, error, updatedAt }) {
      const row = await db.queryOne(
        `UPDATE payment_subscription_authority_revocations
            SET status = ?, error = ?, updated_at = ?
          WHERE id = ? AND lease_id = ? AND status = 'processing'
          RETURNING *`,
        [status, error, updatedAt, id, leaseId]
      );
      return row ? revocationRowSchema.parse(row) : null;
    },

    async claimStaleRevocations({ environment, staleBefore, now, limit }) {
      const rows = await db.queryMany(
        `UPDATE payment_subscription_authority_revocations
            SET updated_at = ?, lease_id = 'lease_' || gen_random_uuid()::text
          WHERE id IN (
            SELECT id FROM payment_subscription_authority_revocations
             WHERE environment = ? AND status = 'processing' AND updated_at <= ?
             ORDER BY updated_at ASC
             LIMIT ?
             FOR UPDATE SKIP LOCKED)
          RETURNING *`,
        [now, environment, staleBefore, limit]
      );
      return rows.map((row) => revocationRowSchema.parse(row));
    },
  };
}
