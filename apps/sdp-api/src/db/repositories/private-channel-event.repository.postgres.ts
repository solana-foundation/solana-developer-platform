import type {
  PrivateChannelEventFamily,
  PrivateChannelEventStatus,
  PrivateChannelEventType,
} from "@sdp/types";
import type { AppDb } from "@/db";
import { asPostgresJsonObject } from "@/db/postgres-utils";
import { internalError } from "@/lib/errors";
import type {
  ListPrivateChannelEventsParams,
  ListProjectPrivateChannelEventsParams,
  PrivateChannelEventRepository,
  PrivateChannelEventRow,
  PrivateChannelEventWriteInput,
} from "./private-channel-event.repository";

function mapPrivateChannelEventRow(row: Record<string, unknown>): PrivateChannelEventRow {
  return {
    id: row.id as string,
    organization_id: row.organization_id as string,
    project_id: row.project_id as string,
    instance_id: row.instance_id as string,
    channel_id: (row.channel_id as string | null) ?? null,
    sdp_user_id: (row.sdp_user_id as string | null) ?? null,
    family: row.family as PrivateChannelEventFamily,
    type: row.type as PrivateChannelEventType,
    status: row.status as PrivateChannelEventStatus,
    payload: asPostgresJsonObject(row.payload),
    occurred_at: row.occurred_at as string,
    created_at: row.created_at as string,
  };
}

function bindWriteArgs(input: PrivateChannelEventWriteInput) {
  return [
    input.id,
    input.organizationId,
    input.projectId,
    input.instanceId,
    input.channelId,
    input.sdpUserId,
    input.family,
    input.type,
    input.status,
    JSON.stringify(input.payload),
    input.occurredAt,
    input.createdAt,
  ] as const;
}

export function createPostgresPrivateChannelEventRepository(
  db: AppDb
): PrivateChannelEventRepository {
  return {
    async insert(input) {
      const row = await db
        .prepare(
          `INSERT INTO private_channel_events (
             id, organization_id, project_id, instance_id, channel_id, sdp_user_id,
             family, type, status, payload, occurred_at, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?)
           RETURNING *`
        )
        .bind(...bindWriteArgs(input))
        .first<Record<string, unknown>>();
      if (!row) {
        throw internalError("private_channel_events INSERT ... RETURNING returned no row");
      }
      return mapPrivateChannelEventRow(row);
    },

    async listByChannel(params: ListPrivateChannelEventsParams) {
      const limit = Math.min(Math.max(params.limit, 1), 100);
      const fetchLimit = limit + 1;

      const clauses = ["instance_id = ?", "(channel_id = ? OR channel_id IS NULL)"];
      const binds: (string | number)[] = [params.instanceId, params.channelId];

      if (params.family) {
        clauses.push("family = ?");
        binds.push(params.family);
      }
      if (params.type) {
        clauses.push("type = ?");
        binds.push(params.type);
      }
      // Composite cursor: (occurred_at, id) is a total order, so ties on
      // occurred_at can't skip or duplicate rows across pages.
      if (params.beforeOccurredAt && params.beforeId) {
        clauses.push("(occurred_at < ? OR (occurred_at = ? AND id < ?))");
        binds.push(params.beforeOccurredAt, params.beforeOccurredAt, params.beforeId);
      }

      binds.push(fetchLimit);

      const result = await db
        .prepare(
          `SELECT * FROM private_channel_events
             WHERE ${clauses.join(" AND ")}
             ORDER BY occurred_at DESC, id DESC
             LIMIT ?`
        )
        .bind(...binds)
        .all<Record<string, unknown>>();

      const mapped = result.results.map(mapPrivateChannelEventRow);
      const hasMore = mapped.length > limit;
      return { rows: hasMore ? mapped.slice(0, limit) : mapped, hasMore };
    },

    async listByProject(params: ListProjectPrivateChannelEventsParams) {
      const limit = Math.min(Math.max(params.limit, 1), 100);
      const fetchLimit = limit + 1;

      const clauses = ["organization_id = ?", "project_id = ?"];
      const binds: (string | number)[] = [params.organizationId, params.projectId];

      if (params.family) {
        clauses.push("family = ?");
        binds.push(params.family);
      }
      if (params.type) {
        clauses.push("type = ?");
        binds.push(params.type);
      }
      if (params.beforeOccurredAt && params.beforeId) {
        clauses.push("(occurred_at < ? OR (occurred_at = ? AND id < ?))");
        binds.push(params.beforeOccurredAt, params.beforeOccurredAt, params.beforeId);
      }

      binds.push(fetchLimit);

      const result = await db
        .prepare(
          `SELECT * FROM private_channel_events
             WHERE ${clauses.join(" AND ")}
             ORDER BY occurred_at DESC, id DESC
             LIMIT ?`
        )
        .bind(...binds)
        .all<Record<string, unknown>>();

      const mapped = result.results.map(mapPrivateChannelEventRow);
      const hasMore = mapped.length > limit;
      return { rows: hasMore ? mapped.slice(0, limit) : mapped, hasMore };
    },
  };
}
