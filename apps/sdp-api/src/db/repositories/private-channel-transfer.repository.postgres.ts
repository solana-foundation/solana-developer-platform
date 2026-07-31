import type { PrivateChannelTransferRecipientDto } from "@sdp/types";
import type { AppDb } from "@/db";
import {
  type CreatePrivateChannelTransferInput,
  DEFAULT_TRANSFER_LIST_LIMIT,
  generatePrivateChannelTransferId,
  type ListEligiblePrivateChannelTransferRecipientsInput,
  type ListPrivateChannelTransfersInput,
  type PrivateChannelTransferProjectScope,
  type PrivateChannelTransferRepository,
  type PrivateChannelTransferRow,
  type UpdatePrivateChannelTransferInput,
} from "./private-channel-transfer.repository";

function mapRow(row: Record<string, unknown>): PrivateChannelTransferRow {
  return {
    id: row.id as string,
    organization_id: row.organization_id as string,
    project_id: row.project_id as string,
    instance_id: row.instance_id as string,
    channel_id: row.channel_id as string,
    sender_private_channel_user_id: row.sender_private_channel_user_id as string,
    recipient_private_channel_user_id: row.recipient_private_channel_user_id as string,
    sender_wallet_id: row.sender_wallet_id as string,
    recipient_verified_wallet_id: row.recipient_verified_wallet_id as string,
    sender: row.sender as string,
    recipient: row.recipient as string,
    mint: row.mint as string,
    amount: row.amount as string,
    status: row.status as PrivateChannelTransferRow["status"],
    signature: (row.signature ?? null) as string | null,
    failure_reason: (row.failure_reason ?? null) as string | null,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

interface EligibleRecipientRow {
  private_channel_user_id: string;
  user_id: string;
  email: string;
  name: string | null;
  verified_wallet_id: string;
  pubkey: string;
}

export function createPostgresPrivateChannelTransferRepository(
  db: AppDb
): PrivateChannelTransferRepository {
  return {
    async createTransfer(input: CreatePrivateChannelTransferInput) {
      const row = await db
        .prepare(
          `INSERT INTO private_channel_transfers (
               id, organization_id, project_id, instance_id, channel_id,
               sender_private_channel_user_id, recipient_private_channel_user_id,
               sender_wallet_id, recipient_verified_wallet_id,
               sender, recipient, mint, amount, status
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
          RETURNING *`
        )
        .bind(
          generatePrivateChannelTransferId(),
          input.organizationId,
          input.projectId,
          input.instanceId,
          input.channelId,
          input.senderPrivateChannelUserId,
          input.recipientPrivateChannelUserId,
          input.senderWalletId,
          input.recipientVerifiedWalletId,
          input.sender,
          input.recipient,
          input.mint,
          input.amount
        )
        .first<Record<string, unknown>>();
      return row ? mapRow(row) : null;
    },

    async updateTransfer(input: UpdatePrivateChannelTransferInput) {
      // COALESCE preserves fields the caller didn't touch. The (?::text IS NULL
      // OR status = ?) pair is a compare-and-swap guard, as in the withdrawal repo.
      const row = await db
        .prepare(
          `UPDATE private_channel_transfers
              SET status = ?,
                  signature = COALESCE(?, signature),
                  failure_reason = COALESCE(?, failure_reason),
                  updated_at = sdp_iso_now()
            WHERE id = ?
              AND (?::text IS NULL OR status = ?)
          RETURNING *`
        )
        .bind(
          input.status,
          input.signature ?? null,
          input.failureReason ?? null,
          input.id,
          input.expectedStatus ?? null,
          input.expectedStatus ?? null
        )
        .first<Record<string, unknown>>();
      return row ? mapRow(row) : null;
    },

    async getTransferById(scope: PrivateChannelTransferProjectScope & { id: string }) {
      const row = await db
        .prepare(
          `SELECT * FROM private_channel_transfers
            WHERE organization_id = ?
              AND project_id = ?
              AND id = ?`
        )
        .bind(scope.organizationId, scope.projectId, scope.id)
        .first<Record<string, unknown>>();
      return row ? mapRow(row) : null;
    },

    async listTransfersByProject(input: ListPrivateChannelTransfersInput) {
      const channelFilter = input.channelId === undefined ? "" : " AND channel_id = ?";
      const limit = input.limit ?? DEFAULT_TRANSFER_LIST_LIMIT;
      const statement = db.prepare(
        `SELECT * FROM private_channel_transfers
          WHERE organization_id = ?
            AND project_id = ?
            ${channelFilter}
          ORDER BY created_at DESC, id DESC
          LIMIT ?`
      );
      const result = await (input.channelId === undefined
        ? statement.bind(input.organizationId, input.projectId, limit)
        : statement.bind(input.organizationId, input.projectId, input.channelId, limit)
      ).all<Record<string, unknown>>();
      return result.results.map(mapRow);
    },

    async listEligibleRecipients(input: ListEligiblePrivateChannelTransferRecipientsInput) {
      const result = await db
        .prepare(
          `SELECT
               pcu.id AS private_channel_user_id,
               u.id AS user_id,
               u.email,
               u.name,
               vw.id AS verified_wallet_id,
               vw.pubkey
             FROM private_channel_memberships m
             INNER JOIN private_channels c
                     ON c.id = m.channel_id
             INNER JOIN private_channel_instances i
                     ON i.id = c.instance_id
             INNER JOIN private_channel_users pcu
                     ON pcu.id = m.private_channel_user_id
             INNER JOIN users u
                     ON u.id = pcu.user_id
             INNER JOIN private_channel_verified_wallets vw
                     ON vw.user_id = pcu.id
                    AND vw.instance_id = c.instance_id
                    AND vw.organization_id = c.organization_id
                    AND vw.project_id = c.project_id
            WHERE c.organization_id = ?
              AND c.project_id = ?
              AND c.instance_id = ?
              AND c.id = ?
              AND c.status = 'active'
              AND i.organization_id = ?
              AND i.project_id = ?
              AND i.id = ?
              AND i.is_active = TRUE
              AND pcu.organization_id = ?
              AND pcu.project_id = ?
              AND pcu.id <> ?
            ORDER BY LOWER(u.email) ASC, pcu.id ASC, vw.pubkey ASC, vw.id ASC`
        )
        .bind(
          input.organizationId,
          input.projectId,
          input.instanceId,
          input.channelId,
          input.organizationId,
          input.projectId,
          input.instanceId,
          input.organizationId,
          input.projectId,
          input.initiatingPrivateChannelUserId
        )
        .all<EligibleRecipientRow>();

      const recipients = new Map<string, PrivateChannelTransferRecipientDto>();
      for (const row of result.results) {
        const recipient = recipients.get(row.private_channel_user_id);
        if (recipient) {
          recipient.wallets.push({ id: row.verified_wallet_id, pubkey: row.pubkey });
          continue;
        }
        recipients.set(row.private_channel_user_id, {
          privateChannelUserId: row.private_channel_user_id,
          userId: row.user_id,
          email: row.email,
          name: row.name,
          wallets: [{ id: row.verified_wallet_id, pubkey: row.pubkey }],
        });
      }
      return [...recipients.values()];
    },
  };
}
