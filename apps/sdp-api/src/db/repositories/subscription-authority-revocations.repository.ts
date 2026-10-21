import { SDP_ENVIRONMENTS, type SdpEnvironment } from "@sdp/types/api-keys";
import { z } from "zod";
import type { DatabaseExecutor } from "@/db/client";

/**
 * Revokes of a wallet's per-mint Subscriptions authority (HOO-2210, migration 0153). The
 * revoke-subscription-authorities cron is the only writer; activation, update and resume only read
 * whether one is in flight on their wallet.
 */

export const SUBSCRIPTION_AUTHORITY_REVOCATION_STATUSES = [
  "processing",
  "confirmed",
  "failed",
] as const;

export type SubscriptionAuthorityRevocationStatus =
  (typeof SUBSCRIPTION_AUTHORITY_REVOCATION_STATUSES)[number];

/**
 * How long after a recurring payment's last change its authority stays: one billing period plus
 * this margin. Cancel ends a subscription at the end of its current period, at most one period
 * after the cancel, and resume needs the authority until then.
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

/** An authority every recurring payment on it has finished with, and the wallet that signs its revoke. */
export type RevocableSubscriptionAuthority = z.infer<typeof candidateRowSchema>;

/**
 * Whether `authority_ref.authority` (a row of authority, wallet, environment, idle_before and
 * retry_failed_before the query supplies) has nothing left that needs it:
 *
 * - every recurring payment on it, in any project of the environment, is `canceled` or `expired`,
 *   and its last change is more than a billing period plus the margin ago, so no canceled
 *   subscription on it can still be resumed;
 * - no recurring payment on the wallet is activating, updating or resuming, which may be about to
 *   use it before it records the authority;
 * - no revoke of it is in flight, none has confirmed since the last change on it, and none failed
 *   within the retry window.
 */
const AUTHORITY_IDLE_PREDICATE = `
  NOT EXISTS (
    SELECT 1 FROM payment_recurring_payments other
      JOIN projects other_project ON other_project.id = other.project_id
     WHERE other.subscription_authority_address = authority_ref.authority
       AND other_project.environment = authority_ref.environment
       AND (other.status NOT IN ('canceled', 'expired')
            OR other.updated_at::timestamptz
                 + make_interval(hours => other.period_hours + ${SUBSCRIPTION_AUTHORITY_IDLE_MARGIN_HOURS})
               > authority_ref.idle_before::timestamptz))
  AND NOT EXISTS (
    SELECT 1 FROM payment_recurring_payments in_flight
      JOIN projects in_flight_project ON in_flight_project.id = in_flight.project_id
     WHERE in_flight.source_address = authority_ref.wallet
       AND in_flight_project.environment = authority_ref.environment
       AND in_flight.status IN ('activating', 'updating', 'resuming'))
  AND NOT EXISTS (
    SELECT 1 FROM payment_subscription_authority_revocations revocation
     WHERE revocation.environment = authority_ref.environment
       AND revocation.subscription_authority_address = authority_ref.authority
       AND (revocation.status = 'processing'
            OR (revocation.status = 'failed' AND revocation.updated_at > authority_ref.retry_failed_before)
            OR (revocation.status = 'confirmed'
                AND revocation.created_at >= (
                  SELECT max(last_change.updated_at) FROM payment_recurring_payments last_change
                    JOIN projects last_change_project ON last_change_project.id = last_change.project_id
                   WHERE last_change.subscription_authority_address = authority_ref.authority
                     AND last_change_project.environment = authority_ref.environment))))`;

export interface SubscriptionAuthorityRevocationsRepository {
  /** Authorities the cron may revoke now, one row each, signed for by their latest recurring payment. */
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
  /** Whether a revoke of any of the wallet's authorities is in flight. Call under the wallet's lock. */
  hasRevocationInFlight(input: {
    environment: SdpEnvironment;
    walletAddress: string;
  }): Promise<boolean>;
  /**
   * Records a `processing` revoke of the authority if it is still idle. Call under the wallet's lock.
   * Null when something now needs the authority or another revoke holds it.
   */
  claimRevocation(input: {
    id: string;
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
  /** Saves the send before it is broadcast. Null when the revoke is no longer `processing`. */
  saveSend(input: {
    id: string;
    signature: string;
    lastValidBlockHeight: string;
    updatedAt: string;
  }): Promise<SubscriptionAuthorityRevocationRow | null>;
  /** Clears a saved send that provably never landed, only while the row still holds it. */
  clearSend(input: { id: string; signature: string; updatedAt: string }): Promise<boolean>;
  /** Ends a `processing` revoke. */
  finish(input: {
    id: string;
    status: Exclude<SubscriptionAuthorityRevocationStatus, "processing">;
    error: string | null;
    updatedAt: string;
  }): Promise<SubscriptionAuthorityRevocationRow | null>;
  /**
   * Takes over `processing` revokes last touched before `staleBefore`, stamping each so a
   * concurrent sweep skips it.
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
        `SELECT DISTINCT ON (rp.subscription_authority_address)
                rp.organization_id, rp.project_id,
                rp.source_custody_wallet_id AS custody_wallet_id,
                rp.source_address AS wallet_address, rp.token, rp.subscription_authority_address
           FROM payment_recurring_payments rp
           JOIN projects p ON p.id = rp.project_id
          CROSS JOIN LATERAL (
            SELECT rp.subscription_authority_address AS authority, rp.source_address AS wallet,
                   p.environment AS environment, ?::text AS idle_before,
                   ?::text AS retry_failed_before
          ) authority_ref
          WHERE p.environment = ?
            AND rp.subscription_authority_address IS NOT NULL
            AND rp.source_custody_wallet_id IS NOT NULL
            AND ${AUTHORITY_IDLE_PREDICATE}
          ORDER BY rp.subscription_authority_address, rp.updated_at DESC
          LIMIT ?`,
        [idleBefore, retryFailedBefore, environment, limit]
      );
      return rows.map((row) => candidateRowSchema.parse(row));
    },

    async lockWalletAuthorities(walletAddress) {
      await db.queryOne(
        "SELECT pg_advisory_xact_lock(hashtext('sdp:subscription-authority'), hashtext(?::text))",
        [walletAddress]
      );
    },

    async hasRevocationInFlight({ environment, walletAddress }) {
      const row = await db.queryOne(
        `SELECT 1 AS in_flight FROM payment_subscription_authority_revocations
          WHERE environment = ? AND wallet_address = ? AND status = 'processing'
          LIMIT 1`,
        [environment, walletAddress]
      );
      return row !== null;
    },

    async claimRevocation(input) {
      const row = await db.queryOne(
        `INSERT INTO payment_subscription_authority_revocations (
            id, organization_id, project_id, environment, custody_wallet_id, wallet_address,
            token_mint, subscription_authority_address, status, created_at, updated_at)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, 'processing', ?, ?
           FROM (SELECT ?::text AS authority, ?::text AS wallet, ?::text AS environment,
                        ?::text AS idle_before, ?::text AS retry_failed_before) authority_ref
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
          input.now,
          input.now,
          input.subscriptionAuthorityAddress,
          input.walletAddress,
          input.environment,
          input.idleBefore,
          input.retryFailedBefore,
        ]
      );
      return row ? revocationRowSchema.parse(row) : null;
    },

    async saveSend({ id, signature, lastValidBlockHeight, updatedAt }) {
      const row = await db.queryOne(
        `UPDATE payment_subscription_authority_revocations
            SET signature = ?, last_valid_block_height = ?::numeric, updated_at = ?
          WHERE id = ? AND status = 'processing'
          RETURNING *`,
        [signature, lastValidBlockHeight, updatedAt, id]
      );
      return row ? revocationRowSchema.parse(row) : null;
    },

    async clearSend({ id, signature, updatedAt }) {
      const cleared = await db.execute(
        `UPDATE payment_subscription_authority_revocations
            SET signature = NULL, last_valid_block_height = NULL, updated_at = ?
          WHERE id = ? AND status = 'processing' AND signature = ?`,
        [updatedAt, id, signature]
      );
      return cleared > 0;
    },

    async finish({ id, status, error, updatedAt }) {
      const row = await db.queryOne(
        `UPDATE payment_subscription_authority_revocations
            SET status = ?, error = ?, updated_at = ?
          WHERE id = ? AND status = 'processing'
          RETURNING *`,
        [status, error, updatedAt, id]
      );
      return row ? revocationRowSchema.parse(row) : null;
    },

    async claimStaleRevocations({ environment, staleBefore, now, limit }) {
      const rows = await db.queryMany(
        `UPDATE payment_subscription_authority_revocations
            SET updated_at = ?
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
