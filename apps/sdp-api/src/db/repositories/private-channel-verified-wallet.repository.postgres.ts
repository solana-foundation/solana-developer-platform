import type { AppDb } from "@/db";
import { conflict } from "@/lib/errors";
import {
  type ConditionalUpsertVerifiedWalletInput,
  generatePrivateChannelVerifiedWalletId,
  mapPrivateChannelVerifiedWalletRow,
  mapPrivateChannelWalletRevocationRow,
  type PrivateChannelVerifiedWalletRepository,
  type RevokeVerifiedWalletInput,
  type UpsertVerifiedWalletInput,
} from "./private-channel-verified-wallet.repository";

/**
 * How long a pending-revocation marker counts as actively owned by another
 * stale verification's compensating delete. Must exceed the worst-case
 * compensating delete — every SPC call times out at 8s
 * (SPC_AUTH_TIMEOUT_MS in services/private-channels/wallets.ts) and the delete
 * chain is at most a 401 token refresh plus the delete — so a marker older
 * than the lease cannot have a compensating delete still in flight, and
 * taking it over is safe. The exception is the undecided-cleanup fallback
 * marker, which never has a delete in flight and is therefore written already
 * outside the lease.
 */
const CLEANUP_CLAIM_LEASE = "30 seconds";

export function createPostgresPrivateChannelVerifiedWalletRepository(
  db: AppDb
): PrivateChannelVerifiedWalletRepository {
  return {
    async upsert(input: ConditionalUpsertVerifiedWalletInput) {
      const row = await db.transaction(async (tx) => {
        // Barrier half 1 (SOLA9-664): make sure the epoch row exists. A
        // first-ever revocation inserts this row in its own transaction, so a
        // plain `SELECT ... FOR UPDATE` of an absent row would lock nothing
        // and that revocation could still interleave with the mirror write.
        await tx
          .prepare(
            `INSERT INTO private_channel_wallet_revocation_epochs (
                 organization_id, project_id, instance_id, pubkey, epoch
               )
               VALUES (?, ?, ?, ?, 0)
             ON CONFLICT (instance_id, pubkey) DO NOTHING`
          )
          .bind(input.organizationId, input.projectId, input.instanceId, input.pubkey)
          .run();

        // Barrier half 2: lock the epoch row for the rest of the transaction.
        // Every revocation advances this row before it removes a mirror, so
        // either it committed first (this read observes the advanced epoch and
        // the write below is refused) or it blocks until this transaction
        // commits and then removes the mirror it writes. Reading the epoch
        // without this lock would let an uncommitted revocation's mirror
        // delete absorb the insert's conflict wait and resurrect the mirror
        // with a stale epoch check.
        const epochRow = await tx
          .prepare(
            `SELECT epoch
                FROM private_channel_wallet_revocation_epochs
               WHERE instance_id = ?
                 AND pubkey = ?
               FOR UPDATE`
          )
          .bind(input.instanceId, input.pubkey)
          .first<{ epoch: number }>();
        if ((epochRow?.epoch ?? 0) !== input.expectedRevocationEpoch) {
          return null;
        }

        // Barrier half 3: a pending-revocation retry marker for this identity
        // means a stale verification's compensating cleanup is still owed an
        // upstream SPC delete for this pubkey. That delete targets the binding
        // at (SPC user, pubkey) — exactly the binding a fresh verification
        // would create — so while the marker is pending the mirror must not
        // land: a verification refused here loses with a retryable conflict
        // instead of handing a live binding to the compensating delete. The
        // marker is written only by transactions holding this same epoch row
        // lock, so this serialized read cannot miss one.
        const pendingRevocation = await tx
          .prepare(
            `SELECT 1
                FROM private_channel_wallet_revocations
               WHERE user_id = ?
                 AND instance_id = ?
                 AND pubkey = ?`
          )
          .bind(input.userId, input.instanceId, input.pubkey)
          .first<{ "1": number }>();
        if (pendingRevocation) {
          return null;
        }

        return tx
          .prepare(
            `WITH active_principal AS (
               SELECT id
                  FROM private_channel_users
                 WHERE id = ?
                   AND organization_id = ?
                   AND project_id = ?
                   AND instance_id = ?
                   AND disabled_at IS NULL
                   AND (spc_user_id IS NOT NULL OR provisioned_at IS NOT NULL)
                 FOR UPDATE
             )
             INSERT INTO private_channel_verified_wallets (
                 id, organization_id, project_id, user_id, instance_id,
                 wallet_id, pubkey
               )
               SELECT ?, ?, ?, id, ?, ?, ?
                 FROM active_principal
             ON CONFLICT (instance_id, pubkey) DO UPDATE
               SET wallet_id = excluded.wallet_id,
                   verified_at = sdp_iso_now(),
                   updated_at = sdp_iso_now()
             WHERE private_channel_verified_wallets.user_id = excluded.user_id
             RETURNING *`
          )
          .bind(
            input.userId,
            input.organizationId,
            input.projectId,
            input.instanceId,
            generatePrivateChannelVerifiedWalletId(),
            input.organizationId,
            input.projectId,
            input.instanceId,
            input.walletId,
            input.pubkey
          )
          .first<Record<string, unknown>>();
      });
      if (!row) {
        throw conflict(
          "This wallet is already linked to another identity. Select a different wallet."
        );
      }
      return mapPrivateChannelVerifiedWalletRow(row);
    },

    async getRevocationEpoch(instanceId: string, pubkey: string) {
      const row = await db
        .prepare(
          `SELECT epoch FROM private_channel_wallet_revocation_epochs
            WHERE instance_id = ?
              AND pubkey = ?`
        )
        .bind(instanceId, pubkey)
        .first<{ epoch: number }>();
      return row?.epoch ?? 0;
    },

    async revokeVerifiedWallet(input: RevokeVerifiedWalletInput) {
      // One transaction: the epoch advance is the barrier that makes an
      // in-flight verification's conditional upsert lose, so it must commit
      // together with the mirror and retry-marker removal.
      const results = await db.batch([
        db
          .prepare(
            `INSERT INTO private_channel_wallet_revocation_epochs (
                 organization_id, project_id, instance_id, pubkey, epoch
               )
               VALUES (?, ?, ?, ?, 1)
               ON CONFLICT (instance_id, pubkey) DO UPDATE
                 SET epoch = private_channel_wallet_revocation_epochs.epoch + 1,
                     updated_at = sdp_iso_now()`
          )
          .bind(input.organizationId, input.projectId, input.instanceId, input.pubkey),
        db
          .prepare(
            `DELETE FROM private_channel_verified_wallets
              WHERE user_id = ?
                AND instance_id = ?
                AND pubkey = ?`
          )
          .bind(input.userId, input.instanceId, input.pubkey),
        db
          .prepare(
            `DELETE FROM private_channel_wallet_revocations
              WHERE user_id = ?
                AND instance_id = ?
                AND pubkey = ?`
          )
          .bind(input.userId, input.instanceId, input.pubkey),
      ]);
      const [, mirrorDeleted, markerDeleted] = results;
      return mirrorDeleted > 0 || markerDeleted > 0;
    },

    async claimStaleVerificationCleanup(input: UpsertVerifiedWalletInput) {
      // The compensating SPC delete of a stale verification must never race a
      // fresh verification: both it and the conditional upsert serialize on
      // the epoch row lock, so whichever transaction commits first decides.
      // Holding that lock while reading the mirror makes the stand-down check
      // exact — a mirror row that belongs to this identity can only be a
      // newer verification's (the revocation this request lost to removed the
      // caller's own row), so its binding must not be deleted. When the claim
      // wins, the epoch advance refuses any verification that has not landed
      // yet, and the retry marker is recorded in the same transaction: if the
      // compensating delete then fails or the process dies, the next
      // principal-disable cleanup still finds the late upstream binding. The
      // claim also stands down while another stale verification's cleanup for
      // the same binding is still pending (a fresh marker), so the latch can
      // only ever be cleared by the single delete it covers.
      return db.transaction(async (tx) => {
        await tx
          .prepare(
            `INSERT INTO private_channel_wallet_revocation_epochs (
                 organization_id, project_id, instance_id, pubkey, epoch
               )
               VALUES (?, ?, ?, ?, 0)
             ON CONFLICT (instance_id, pubkey) DO NOTHING`
          )
          .bind(input.organizationId, input.projectId, input.instanceId, input.pubkey)
          .run();

        await tx
          .prepare(
            `SELECT epoch
                FROM private_channel_wallet_revocation_epochs
               WHERE instance_id = ?
                 AND pubkey = ?
               FOR UPDATE`
          )
          .bind(input.instanceId, input.pubkey)
          .first<{ epoch: number }>();

        const mirror = await tx
          .prepare(
            `SELECT user_id
                 FROM private_channel_verified_wallets
                WHERE instance_id = ?
                  AND pubkey = ?`
          )
          .bind(input.instanceId, input.pubkey)
          .first<{ user_id: string }>();
        if (mirror?.user_id === input.userId) {
          return false;
        }

        // SPC keeps ONE binding per (SPC user, pubkey), so every stale
        // verification of this wallet owes a delete for the same binding and
        // one compensating delete covers them all. A pending marker for this
        // identity therefore means another rejected verification's cleanup is
        // the single owner of that delete: a second claimant must not start
        // its own delete, because the first finisher would clear this shared
        // latch while the second delete is still in flight and a fresh
        // verification landing in that window would lose its new binding and
        // mirror to the outstanding delete. Stand down while the marker is
        // fresh; the pending cleaner converges the binding. A marker older
        // than the lease cannot have a delete in flight (its owner's calls
        // are timeout-bounded), so taking it over is safe: that covers an
        // owner that died mid-cleanup and the undecided-cleanup fallback
        // marker, either of which would otherwise latch verifications here
        // forever.
        const pendingMarker = await tx
          .prepare(
            `SELECT (sdp_iso_now()::timestamptz - updated_at::timestamptz)
                  < interval '${CLEANUP_CLAIM_LEASE}' AS lease_active
               FROM private_channel_wallet_revocations
              WHERE user_id = ?
                AND instance_id = ?
                AND pubkey = ?`
          )
          .bind(input.userId, input.instanceId, input.pubkey)
          .first<{ lease_active: boolean }>();
        if (pendingMarker?.lease_active) {
          return false;
        }

        // The claim wins: advance the epoch — the same barrier a revocation
        // uses, so any verification that has not landed yet is refused — and
        // (re)record the retry marker in the same transaction, freshening its
        // lease.
        await tx
          .prepare(
            `UPDATE private_channel_wallet_revocation_epochs
                 SET epoch = private_channel_wallet_revocation_epochs.epoch + 1,
                     updated_at = sdp_iso_now()
               WHERE instance_id = ?
                 AND pubkey = ?`
          )
          .bind(input.instanceId, input.pubkey)
          .run();
        await tx
          .prepare(
            `INSERT INTO private_channel_wallet_revocations (
                 id, organization_id, project_id, user_id, instance_id,
                 wallet_id, pubkey
               )
               VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (user_id, instance_id, pubkey) DO UPDATE
               SET wallet_id = excluded.wallet_id,
                   updated_at = sdp_iso_now()`
          )
          .bind(
            generatePrivateChannelVerifiedWalletId(),
            input.organizationId,
            input.projectId,
            input.userId,
            input.instanceId,
            input.walletId,
            input.pubkey
          )
          .run();
        return true;
      });
    },

    async hasPendingRevocation(userId: string, instanceId: string, pubkey: string) {
      const row = await db
        .prepare(
          `SELECT 1 FROM private_channel_wallet_revocations
            WHERE user_id = ?
              AND instance_id = ?
              AND pubkey = ?
            LIMIT 1`
        )
        .bind(userId, instanceId, pubkey)
        .first<{ "1": number }>();
      return row !== null;
    },

    async recordPendingRevocation(input: UpsertVerifiedWalletInput) {
      // The undecided-cleanup fallback: record the retry marker WITHOUT
      // advancing the epoch, so the next principal-disable cleanup finds a late
      // upstream binding even when the cleanup claim itself failed and nobody
      // can say whether a compensating delete is still owed. Whether a fresh
      // verification now owns the binding is decided under the epoch row lock
      // (the same serialization the claim uses): a mirror that belongs to this
      // identity is a newer verification's, its binding must survive, and no
      // marker is recorded — recording one would latch the mirror upsert
      // against a mirror that already exists.
      //
      // The record is also skipped when a marker already exists: it may belong
      // to a cleanup claim whose compensating delete is still in flight, and
      // refreshing that marker's lease is the claim's job. A marker this
      // fallback creates fresh is written already outside the cleanup lease —
      // no compensating delete is in flight for it, so the next refused
      // verification takes the cleanup over immediately instead of standing
      // down for a whole lease.
      return db.transaction(async (tx) => {
        await tx
          .prepare(
            `INSERT INTO private_channel_wallet_revocation_epochs (
                 organization_id, project_id, instance_id, pubkey, epoch
               )
               VALUES (?, ?, ?, ?, 0)
             ON CONFLICT (instance_id, pubkey) DO NOTHING`
          )
          .bind(input.organizationId, input.projectId, input.instanceId, input.pubkey)
          .run();

        await tx
          .prepare(
            `SELECT epoch
                FROM private_channel_wallet_revocation_epochs
               WHERE instance_id = ?
                 AND pubkey = ?
               FOR UPDATE`
          )
          .bind(input.instanceId, input.pubkey)
          .first<{ epoch: number }>();

        const mirror = await tx
          .prepare(
            `SELECT user_id
                FROM private_channel_verified_wallets
               WHERE instance_id = ?
                 AND pubkey = ?`
          )
          .bind(input.instanceId, input.pubkey)
          .first<{ user_id: string }>();
        if (mirror?.user_id === input.userId) {
          return false;
        }

        const backdated = new Date(Date.now() - 3_600_000).toISOString();
        const inserted = await tx
          .prepare(
            `INSERT INTO private_channel_wallet_revocations (
                 id, organization_id, project_id, user_id, instance_id,
                 wallet_id, pubkey, created_at, updated_at
               )
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (user_id, instance_id, pubkey) DO NOTHING`
          )
          .bind(
            generatePrivateChannelVerifiedWalletId(),
            input.organizationId,
            input.projectId,
            input.userId,
            input.instanceId,
            input.walletId,
            input.pubkey,
            backdated,
            backdated
          )
          .run();
        return inserted > 0;
      });
    },

    async listPendingRevocations(userId: string, instanceId: string) {
      const result = await db
        .prepare(
          `SELECT * FROM private_channel_wallet_revocations
             WHERE user_id = ?
               AND instance_id = ?
             ORDER BY created_at ASC, id ASC`
        )
        .bind(userId, instanceId)
        .all<Record<string, unknown>>();
      return (result.results ?? []).map(mapPrivateChannelWalletRevocationRow);
    },

    async findByInstanceAndPubkey(scope, instanceId, pubkey) {
      const row = await db
        .prepare(
          `SELECT * FROM private_channel_verified_wallets
             WHERE organization_id = ?
               AND project_id = ?
               AND instance_id = ?
               AND pubkey = ?
             LIMIT 1`
        )
        .bind(scope.organizationId, scope.projectId, instanceId, pubkey)
        .first<Record<string, unknown>>();
      return row ? mapPrivateChannelVerifiedWalletRow(row) : null;
    },

    async listByUserAndInstance(userId: string, instanceId: string) {
      const result = await db
        .prepare(
          `SELECT * FROM private_channel_verified_wallets
             WHERE user_id = ?
               AND instance_id = ?
             ORDER BY verified_at DESC, id DESC`
        )
        .bind(userId, instanceId)
        .all<Record<string, unknown>>();
      return (result.results ?? []).map(mapPrivateChannelVerifiedWalletRow);
    },

    async findAnyByInstanceAndPubkey(instanceId: string, pubkey: string) {
      // Uniqueness is (user_id, instance_id, pubkey), so several members may
      // have verified the same pubkey. The question here is only "has ANYONE
      // proved control of this address on this instance", which is what makes a
      // credited balance spendable — so the newest row is a fine witness.
      const row = await db
        .prepare(
          `SELECT * FROM private_channel_verified_wallets
             WHERE instance_id = ?
               AND pubkey = ?
             ORDER BY verified_at DESC, id DESC
             LIMIT 1`
        )
        .bind(instanceId, pubkey)
        .first<Record<string, unknown>>();
      return row ? mapPrivateChannelVerifiedWalletRow(row) : null;
    },
  };
}
