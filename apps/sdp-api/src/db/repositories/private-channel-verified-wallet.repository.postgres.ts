import type { AppDb } from "@/db";
import {
  generatePrivateChannelVerifiedWalletId,
  mapPrivateChannelVerifiedWalletRow,
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
          `INSERT INTO private_channel_verified_wallets (
               id, organization_id, project_id, user_id, instance_id,
               wallet_id, pubkey
             ) VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (user_id, instance_id, pubkey) DO UPDATE
               SET wallet_id = excluded.wallet_id,
                   verified_at = sdp_iso_now(),
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
        throw new Error("Failed to persist verified wallet");
      }
      return mapPrivateChannelVerifiedWalletRow(row);
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
