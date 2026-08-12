import type { AppDb } from "@/db";
import {
  type AddMembershipInput,
  type CreatePrivateChannelUserInput,
  generatePrivateChannelMembershipId,
  type PrivateChannelMembershipRow,
  type PrivateChannelMembershipWithChannelRow,
  type PrivateChannelUserRepository,
  type PrivateChannelUserRow,
  type PrivateChannelUserWithIdentityRow,
  type ProjectScope,
} from "./private-channel-user.repository";

function mapUserRow(row: Record<string, unknown>): PrivateChannelUserRow {
  return {
    id: row.id as string,
    organization_id: row.organization_id as string,
    project_id: row.project_id as string,
    user_id: row.user_id as string,
    spc_user_id: (row.spc_user_id ?? null) as string | null,
    spc_username: (row.spc_username ?? null) as string | null,
    spc_credential_ciphertext: (row.spc_credential_ciphertext ?? null) as string | null,
    invited_by: (row.invited_by ?? null) as string | null,
    invite_token: (row.invite_token ?? null) as string | null,
    invited_at: row.invited_at as string,
    accepted_at: (row.accepted_at ?? null) as string | null,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

function mapUserWithIdentityRow(row: Record<string, unknown>): PrivateChannelUserWithIdentityRow {
  return {
    ...mapUserRow(row),
    user_email: row.user_email as string,
    user_name: (row.user_name ?? null) as string | null,
    verified_wallet_count: Number(row.verified_wallet_count ?? 0),
    project_role: (row.project_role ?? null) as string | null,
  };
}

function mapMembershipWithChannelRow(
  row: Record<string, unknown>
): PrivateChannelMembershipWithChannelRow {
  return {
    id: row.id as string,
    channel_id: row.channel_id as string,
    private_channel_user_id: row.private_channel_user_id as string,
    added_by: (row.added_by ?? null) as string | null,
    added_at: row.added_at as string,
    channel_name: row.channel_name as string,
    channel_is_default: Boolean(row.channel_is_default),
  };
}

const USER_SELECT = `
  pcu.*,
  u.email AS user_email,
  u.name  AS user_name,
  pm.role AS project_role,
  (
    SELECT COUNT(*)
      FROM private_channel_verified_wallets vw
     WHERE vw.user_id = pcu.id
       AND vw.instance_id = (
             SELECT id FROM private_channel_instances
              WHERE project_id = pcu.project_id AND is_active = TRUE
           )
  ) AS verified_wallet_count
`;

// LEFT JOIN so PCU rows survive later removal from project_members (orphans stay visible for cleanup).
const USER_JOINS = `
  INNER JOIN users u ON u.id = pcu.user_id
  LEFT  JOIN project_members pm ON pm.project_id = pcu.project_id AND pm.user_id = pcu.user_id
`;

export function createPostgresPrivateChannelUserRepository(
  db: AppDb
): PrivateChannelUserRepository {
  return {
    async listByProject(scope: ProjectScope) {
      const { results = [] } = await db
        .prepare(
          `SELECT ${USER_SELECT}
             FROM private_channel_users pcu
             ${USER_JOINS}
            WHERE pcu.organization_id = ?
              AND pcu.project_id = ?
            ORDER BY pcu.created_at DESC, pcu.id DESC`
        )
        .bind(scope.organizationId, scope.projectId)
        .all<Record<string, unknown>>();
      return results.map(mapUserWithIdentityRow);
    },

    async getById(scope, id) {
      const row = await db
        .prepare(
          `SELECT ${USER_SELECT}
             FROM private_channel_users pcu
             ${USER_JOINS}
            WHERE pcu.id = ?
              AND pcu.organization_id = ?
              AND pcu.project_id = ?`
        )
        .bind(id, scope.organizationId, scope.projectId)
        .first<Record<string, unknown>>();
      return row ? mapUserWithIdentityRow(row) : null;
    },

    async findByProjectAndUser(scope, userId) {
      const row = await db
        .prepare(
          `SELECT * FROM private_channel_users
            WHERE organization_id = ?
              AND project_id = ?
              AND user_id = ?`
        )
        .bind(scope.organizationId, scope.projectId, userId)
        .first<Record<string, unknown>>();
      return row ? mapUserRow(row) : null;
    },

    async getByProjectAndUser(scope, userId) {
      const row = await db
        .prepare(
          `SELECT ${USER_SELECT}
             FROM private_channel_users pcu
             ${USER_JOINS}
            WHERE pcu.organization_id = ?
              AND pcu.project_id = ?
              AND pcu.user_id = ?`
        )
        .bind(scope.organizationId, scope.projectId, userId)
        .first<Record<string, unknown>>();
      return row ? mapUserWithIdentityRow(row) : null;
    },

    async create(input: CreatePrivateChannelUserInput) {
      const row = await db
        .prepare(
          `INSERT INTO private_channel_users (
               id, organization_id, project_id, user_id,
               spc_user_id, spc_username, spc_credential_ciphertext,
               invited_by, invite_token
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          RETURNING id`
        )
        .bind(
          `pcu_${crypto.randomUUID()}`,
          input.organizationId,
          input.projectId,
          input.userId,
          input.spcUserId,
          input.spcUsername,
          input.spcCredentialCiphertext,
          input.invitedBy,
          input.inviteToken
        )
        .first<{ id: string }>();
      if (!row) throw new Error("private_channel_users insert returned no id");

      const full = await db
        .prepare(
          `SELECT ${USER_SELECT}
             FROM private_channel_users pcu
             ${USER_JOINS}
            WHERE pcu.id = ?`
        )
        .bind(row.id)
        .first<Record<string, unknown>>();
      if (!full) throw new Error("private_channel_users insert not readable");
      return mapUserWithIdentityRow(full);
    },

    async deleteById(scope, id) {
      const row = await db
        .prepare(
          `DELETE FROM private_channel_users
            WHERE id = ?
              AND organization_id = ?
              AND project_id = ?
          RETURNING id`
        )
        .bind(id, scope.organizationId, scope.projectId)
        .first<{ id: string }>();
      return row !== null;
    },

    async listMembershipsByProject(scope) {
      const { results = [] } = await db
        .prepare(
          `SELECT m.*,
                  c.name       AS channel_name,
                  c.is_default AS channel_is_default
             FROM private_channel_memberships m
             INNER JOIN private_channels c        ON c.id = m.channel_id
             INNER JOIN private_channel_users pcu ON pcu.id = m.private_channel_user_id
            WHERE pcu.organization_id = ?
              AND pcu.project_id = ?`
        )
        .bind(scope.organizationId, scope.projectId)
        .all<Record<string, unknown>>();
      const grouped = new Map<string, PrivateChannelMembershipWithChannelRow[]>();
      for (const raw of results) {
        const row = mapMembershipWithChannelRow(raw);
        const bucket = grouped.get(row.private_channel_user_id) ?? [];
        bucket.push(row);
        grouped.set(row.private_channel_user_id, bucket);
      }
      return grouped;
    },

    async listMembershipsForUser(privateChannelUserId) {
      const { results = [] } = await db
        .prepare(
          `SELECT m.*,
                  c.name       AS channel_name,
                  c.is_default AS channel_is_default
             FROM private_channel_memberships m
             INNER JOIN private_channels c ON c.id = m.channel_id
            WHERE m.private_channel_user_id = ?`
        )
        .bind(privateChannelUserId)
        .all<Record<string, unknown>>();
      return results.map(mapMembershipWithChannelRow);
    },

    async addMembership(input: AddMembershipInput): Promise<PrivateChannelMembershipRow> {
      // Idempotent: ON CONFLICT DO UPDATE (no-op) so we always return a row.
      // `RETURNING` on both insert + no-op update gives us the winning row's id
      // even when the row already existed.
      const row = await db
        .prepare(
          `INSERT INTO private_channel_memberships (
               id, channel_id, private_channel_user_id, added_by
             ) VALUES (?, ?, ?, ?)
          ON CONFLICT (channel_id, private_channel_user_id) DO UPDATE
             SET added_at = private_channel_memberships.added_at
          RETURNING *`
        )
        .bind(
          generatePrivateChannelMembershipId(),
          input.channelId,
          input.privateChannelUserId,
          input.addedBy
        )
        .first<Record<string, unknown>>();
      if (!row) throw new Error("private_channel_memberships insert returned no row");
      return {
        id: row.id as string,
        channel_id: row.channel_id as string,
        private_channel_user_id: row.private_channel_user_id as string,
        added_by: (row.added_by ?? null) as string | null,
        added_at: row.added_at as string,
      };
    },

    async removeMembership(channelId, privateChannelUserId) {
      const row = await db
        .prepare(
          `DELETE FROM private_channel_memberships
            WHERE channel_id = ?
              AND private_channel_user_id = ?
          RETURNING id`
        )
        .bind(channelId, privateChannelUserId)
        .first<{ id: string }>();
      return row !== null;
    },
  };
}
