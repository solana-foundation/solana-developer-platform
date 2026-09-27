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

    async recordPendingRevocation(input: UpsertVerifiedWalletInput) {
      const row = await db
        .prepare(
          `INSERT INTO private_channel_wallet_revocations (
               id, organization_id, project_id, user_id, instance_id,
               wallet_id, pubkey
             )
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (user_id, instance_id, pubkey) DO UPDATE
               SET wallet_id = excluded.wallet_id,
                   updated_at = sdp_iso_now()
          RETURNING *`
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
        .first<Record<string, unknown>>();
      if (!row) {
        throw conflict("Could not record the wallet binding for cleanup.");
      }
      return mapPrivateChannelWalletRevocationRow(row);
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
