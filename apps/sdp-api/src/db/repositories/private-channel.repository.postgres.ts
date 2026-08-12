import {
  DEFAULT_PRIVATE_CHANNEL_NAME,
  type PrivateChannelRow,
} from "@sdp/private-channels/channels";
import type { AppDb } from "@/db";
import {
  generatePrivateChannelId,
  type PrivateChannelRepository,
  type PrivateChannelScope,
} from "./private-channel.repository";

function mapPrivateChannelRow(row: Record<string, unknown>): PrivateChannelRow {
  return {
    id: row.id as string,
    organization_id: row.organization_id as string,
    project_id: row.project_id as string,
    instance_id: row.instance_id as string,
    name: row.name as string,
    description: (row.description as string | null) ?? null,
    is_default: row.is_default as boolean,
    status: row.status as PrivateChannelRow["status"],
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

async function getByIdInternal(
  db: AppDb,
  params: { channelId: string; instanceId: string }
): Promise<PrivateChannelRow | null> {
  const row = await db
    .prepare(
      "SELECT * FROM private_channels WHERE id = ? AND instance_id = ? AND status = 'active'"
    )
    .bind(params.channelId, params.instanceId)
    .first<Record<string, unknown>>();
  return row ? mapPrivateChannelRow(row) : null;
}

async function getDefaultInternal(
  db: AppDb,
  instanceId: string
): Promise<PrivateChannelRow | null> {
  const row = await db
    .prepare("SELECT * FROM private_channels WHERE instance_id = ? AND is_default LIMIT 1")
    .bind(instanceId)
    .first<Record<string, unknown>>();
  return row ? mapPrivateChannelRow(row) : null;
}

// No inference target: DO NOTHING swallows both the one-default and the
// (instance_id, name) unique index, so a concurrent create or name collision
// never throws.
async function insertDefault(db: AppDb, scope: PrivateChannelScope, name: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO private_channels (id, organization_id, project_id, instance_id, name, is_default)
         VALUES (?, ?, ?, ?, ?, true)
         ON CONFLICT DO NOTHING`
    )
    .bind(generatePrivateChannelId(), scope.organizationId, scope.projectId, scope.instanceId, name)
    .run();
}

export function createPostgresPrivateChannelRepository(db: AppDb): PrivateChannelRepository {
  return {
    async getOrCreateDefault(scope) {
      const existing = await getDefaultInternal(db, scope.instanceId);
      if (existing) {
        return { channel: existing, created: false };
      }

      await insertDefault(db, scope, DEFAULT_PRIVATE_CHANNEL_NAME);
      const created = await getDefaultInternal(db, scope.instanceId);
      if (created) {
        return { channel: created, created: true };
      }

      // Canonical name is held by a non-default channel and no default exists —
      // retry with a suffixed, collision-free name.
      await insertDefault(
        db,
        scope,
        `${DEFAULT_PRIVATE_CHANNEL_NAME} ${generatePrivateChannelId().slice(-6)}`
      );
      const fallback = await getDefaultInternal(db, scope.instanceId);
      if (!fallback) {
        throw new Error("Failed to ensure the default private channel.");
      }
      return { channel: fallback, created: true };
    },

    async createChannel({ instanceId, organizationId, projectId, name, description }) {
      const id = generatePrivateChannelId();
      const rowsAffected = await db
        .prepare(
          `INSERT INTO private_channels (id, organization_id, project_id, instance_id, name, description, is_default)
             VALUES (?, ?, ?, ?, ?, ?, false)
             ON CONFLICT (instance_id, name) DO NOTHING`
        )
        .bind(id, organizationId, projectId, instanceId, name, description)
        .run();

      if (rowsAffected === 0) {
        return null;
      }
      return getByIdInternal(db, { channelId: id, instanceId });
    },

    async listChannels({ instanceId }) {
      const result = await db
        .prepare(
          "SELECT * FROM private_channels WHERE instance_id = ? AND status = 'active' ORDER BY created_at DESC, id DESC"
        )
        .bind(instanceId)
        .all<Record<string, unknown>>();
      return result.results.map(mapPrivateChannelRow);
    },

    async getChannel({ channelId, instanceId }) {
      return getByIdInternal(db, { channelId, instanceId });
    },

    async archiveChannel({ channelId, instanceId }) {
      const rowsAffected = await db
        .prepare(
          `UPDATE private_channels
             SET status = 'archived', updated_at = sdp_iso_now()
             WHERE id = ? AND instance_id = ? AND status = 'active'`
        )
        .bind(channelId, instanceId)
        .run();
      return rowsAffected > 0;
    },

    async findInProject({ organizationId, projectId, channelId }) {
      const row = await db
        .prepare(
          `SELECT c.*
             FROM private_channels c
             INNER JOIN private_channel_instances i ON i.id = c.instance_id
            WHERE c.id = ?
              AND i.organization_id = ?
              AND i.project_id = ?`
        )
        .bind(channelId, organizationId, projectId)
        .first<Record<string, unknown>>();
      return row ? mapPrivateChannelRow(row) : null;
    },
  };
}
