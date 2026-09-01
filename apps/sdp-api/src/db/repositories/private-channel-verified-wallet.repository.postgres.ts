import type { AppDb } from "@/db";
import { conflict } from "@/lib/errors";
import {
  generatePrivateChannelVerifiedWalletId,
  mapPrivateChannelVerifiedWalletRow,
  mapPrivateChannelWalletRevocationRow,
  type PrivateChannelVerifiedWalletRepository,
  type UpsertVerifiedWalletInput,
} from "./private-channel-verified-wallet.repository";

export function createPostgresPrivateChannelVerifiedWalletRepository(
  db: AppDb
): PrivateChannelVerifiedWalletRepository {
  return {
    async upsert(input: UpsertVerifiedWalletInput) {
      const row = await db
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
      if (!row) {
        throw conflict(
          "This wallet is already linked to another identity. Select a different wallet."
        );
      }
      return mapPrivateChannelVerifiedWalletRow(row);
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

    async deletePendingRevocation(userId: string, instanceId: string, pubkey: string) {
      const row = await db
        .prepare(
          `DELETE FROM private_channel_wallet_revocations
             WHERE user_id = ?
               AND instance_id = ?
               AND pubkey = ?
          RETURNING id`
        )
        .bind(userId, instanceId, pubkey)
        .first<Record<string, unknown>>();
      return row !== null;
    },

    async deleteByUserInstanceAndPubkey(userId: string, instanceId: string, pubkey: string) {
      const row = await db
        .prepare(
          `DELETE FROM private_channel_verified_wallets
             WHERE user_id = ?
               AND instance_id = ?
               AND pubkey = ?
          RETURNING id`
        )
        .bind(userId, instanceId, pubkey)
        .first<Record<string, unknown>>();
      return row !== null;
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
  };
}
