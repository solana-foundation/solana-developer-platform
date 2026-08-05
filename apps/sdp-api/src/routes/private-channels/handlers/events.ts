import type {
  PrivateChannelEventDto,
  PrivateChannelEventFamily,
  PrivateChannelEventStatus,
} from "@sdp/types";
import { hasPermission, PRIVATE_CHANNEL_EVENT_DISPLAY_PAYLOAD_KEYS } from "@sdp/types";
import type { PrivateChannelEventRow } from "@/db/repositories";
import { getAuth, requireProjectId } from "@/lib/auth";
import { badRequest, notFound } from "@/lib/errors";
import { success } from "@/lib/response";
import type { AppContext } from "../context";
import { getPrivateChannelEventRepository, getPrivateChannelRepository } from "../context";
import { resolveEventViewer } from "../event-access";
import { requireActiveInstance } from "../helpers";
import { privateChannelEventsQuerySchema } from "../schemas";

/**
 * Opaque page cursor encoding the last row's (occurredAt, id). Base64url so
 * clients treat it as opaque; occurred_at never contains "|".
 */
function encodeCursor(occurredAt: string, id: string): string {
  return btoa(`${occurredAt}|${id}`).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeCursor(cursor: string): { occurredAt: string; id: string } | null {
  try {
    const decoded = atob(cursor.replace(/-/g, "+").replace(/_/g, "/"));
    const separator = decoded.indexOf("|");
    if (separator <= 0 || separator === decoded.length - 1) {
      return null;
    }
    return { occurredAt: decoded.slice(0, separator), id: decoded.slice(separator + 1) };
  } catch {
    return null;
  }
}

function displayEventPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const displayPayload: Record<string, unknown> = {};
  for (const key of PRIVATE_CHANNEL_EVENT_DISPLAY_PAYLOAD_KEYS) {
    // Optional read so a hand-written JSON `null` in the column can't 500 the feed.
    const value = payload?.[key];
    if (typeof value === "string" || (typeof value === "number" && Number.isFinite(value))) {
      displayPayload[key] = value;
    }
  }
  return displayPayload;
}

function mapPrivateChannelEventRow(
  row: PrivateChannelEventRow,
  includeRawPayload: boolean
): PrivateChannelEventDto {
  return {
    id: row.id,
    organizationId: row.organization_id,
    projectId: row.project_id,
    instanceId: row.instance_id,
    channelId: row.channel_id,
    sdpUserId: row.sdp_user_id,
    family: row.family,
    type: row.type,
    status: row.status,
    payload: includeRawPayload ? row.payload : displayEventPayload(row.payload),
    occurredAt: row.occurred_at,
    createdAt: row.created_at,
  };
}

interface ParsedEventsQuery {
  family?: PrivateChannelEventFamily;
  type?: string;
  status?: PrivateChannelEventStatus;
  limit: number;
  cursor: { occurredAt: string; id: string } | null;
}

function parseEventsQuery(c: AppContext): ParsedEventsQuery {
  const parsed = privateChannelEventsQuerySchema.safeParse({
    family: c.req.query("family") || undefined,
    type: c.req.query("type") || undefined,
    status: c.req.query("status") || undefined,
    limit: c.req.query("limit") || undefined,
    before: c.req.query("before") || undefined,
  });
  if (!parsed.success) {
    throw badRequest("Invalid events query");
  }
  const { family, type, status, before } = parsed.data;
  const cursor = before ? decodeCursor(before) : null;
  if (before && !cursor) {
    throw badRequest("Invalid pagination cursor");
  }
  return { family, type, status, limit: parsed.data.limit ?? 50, cursor };
}

function eventsEnvelope(c: AppContext, rows: PrivateChannelEventRow[], hasMore: boolean) {
  const last = rows.at(-1);
  const nextCursor = hasMore && last ? encodeCursor(last.occurred_at, last.id) : null;
  const auth = getAuth(c);
  const includeRawPayload =
    auth.authType !== "api_key" && hasPermission(auth.permissions, "org:admin");
  return success(c, {
    events: rows.map((row) => mapPrivateChannelEventRow(row, includeRawPayload)),
    hasMore,
    nextCursor,
  });
}

/** GET /channels/:id/events — paginated activity feed for a channel. */
export async function listChannelEvents(c: AppContext) {
  const instance = await requireActiveInstance(c);
  const channelId = c.req.param("id");
  if (!channelId) {
    throw badRequest("Channel id is required");
  }

  const channel = await getPrivateChannelRepository(c).getChannel({
    channelId,
    instanceId: instance.id,
  });
  if (!channel) {
    throw notFound("Channel");
  }

  const { family, type, status, limit, cursor } = parseEventsQuery(c);
  const viewer = await resolveEventViewer(c);
  if (viewer.scope === "none") {
    return eventsEnvelope(c, [], false);
  }
  if (viewer.scope === "member" && !viewer.channelIds.includes(channelId)) {
    return eventsEnvelope(c, [], false);
  }
  const { rows, hasMore } = await getPrivateChannelEventRepository(c).listByChannel({
    channelId,
    instanceId: instance.id,
    family,
    type,
    status,
    viewerUserId: viewer.scope === "member" ? viewer.userId : undefined,
    limit,
    beforeOccurredAt: cursor?.occurredAt,
    beforeId: cursor?.id,
  });

  return eventsEnvelope(c, rows, hasMore);
}

/**
 * GET /events — project-scoped activity feed.
 */
export async function listProjectEvents(c: AppContext) {
  const { organizationId } = getAuth(c);
  const projectId = requireProjectId(c);

  const { family, type, status, limit, cursor } = parseEventsQuery(c);
  const viewer = await resolveEventViewer(c);
  if (viewer.scope === "none") {
    return eventsEnvelope(c, [], false);
  }
  const { rows, hasMore } = await getPrivateChannelEventRepository(c).listByProject({
    organizationId,
    projectId,
    family,
    type,
    status,
    viewer:
      viewer.scope === "member"
        ? { channelIds: viewer.channelIds, userId: viewer.userId }
        : undefined,
    limit,
    beforeOccurredAt: cursor?.occurredAt,
    beforeId: cursor?.id,
  });

  return eventsEnvelope(c, rows, hasMore);
}
