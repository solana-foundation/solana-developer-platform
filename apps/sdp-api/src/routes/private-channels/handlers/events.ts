import {
  PRIVATE_CHANNEL_EVENT_DISPLAY_PAYLOAD_KEYS,
  type PrivateChannelEventDto,
  type PrivateChannelEventFamily,
  type PrivateChannelEventStatus,
} from "@sdp/types/private-channels";
import { z } from "zod";
import type { PrivateChannelEventRow } from "@/db/repositories/private-channel-event.repository";
import { getAuth, requireProjectId } from "@/lib/auth";
import { badRequest, notFound } from "@/lib/errors";
import { decodeKeysetCursor, encodeKeysetCursor } from "@/lib/keyset-cursor";
import { success } from "@/lib/response";
import { callerMayPerform } from "@/middleware/require-action";
import {
  type AppContext,
  getPrivateChannelEventRepository,
  getPrivateChannelRepository,
} from "@/routes/private-channels/context";
import { resolveEventViewer } from "@/routes/private-channels/event-access";
import { requireActiveInstance } from "@/routes/private-channels/helpers";
import { privateChannelEventsQuerySchema } from "@/routes/private-channels/schemas";
import { resolvePrivateChannelCustodyLinks } from "@/services/private-channels/custody-links";

function displayEventPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const displayPayload: Record<string, unknown> = {};
  for (const key of PRIVATE_CHANNEL_EVENT_DISPLAY_PAYLOAD_KEYS) {
    // Optional read so a hand-written JSON `null` in the column can't 500 the feed.
    const value = payload?.[key];
    if (
      typeof value === "string" ||
      (typeof value === "number" && Number.isFinite(value)) ||
      (key === "custodyWalletId" && value === null)
    ) {
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
  const decodedCursor = before ? decodeKeysetCursor(before) : null;
  const cursor = decodedCursor ? { occurredAt: decodedCursor.value, id: decodedCursor.id } : null;
  if (before && !cursor) {
    throw badRequest("Invalid pagination cursor");
  }
  return { family, type, status, limit: parsed.data.limit ?? 50, cursor };
}

const identityField = z.string().optional();
const eventIdentitySchema = z.object({
  custodyWalletId: identityField.nullable(),
  walletId: identityField,
  pubkey: identityField,
  depositId: identityField,
  withdrawalId: identityField,
  transferId: identityField,
});
const movementIdFields = {
  deposit: "depositId",
  withdrawal: "withdrawalId",
  transfer: "transferId",
} as const;

async function projectEventCustodyLinks(c: AppContext, rows: PrivateChannelEventRow[]) {
  if (!rows.length) return rows;
  const scope = { organizationId: getAuth(c).organizationId, projectId: requireProjectId(c) };
  const identities = rows.map((row) => eventIdentitySchema.parse(row.payload));
  const ids = (key: "depositId" | "withdrawalId" | "transferId") =>
    identities.flatMap((identity) => (identity[key] ? [identity[key]] : []));
  const sources = await getPrivateChannelEventRepository(c).listMovementSources({
    ...scope,
    depositIds: ids("depositId"),
    withdrawalIds: ids("withdrawalId"),
    transferIds: ids("transferId"),
  });
  const proved = await resolvePrivateChannelCustodyLinks(c.env, scope, [
    ...sources,
    ...identities.map((identity) => ({
      custody_wallet_id: identity.custodyWalletId ?? null,
      wallet_id: identity.walletId,
      pubkey: identity.pubkey,
    })),
  ]);
  const sourceLinks = new Map(
    sources.map((source, index) => [
      `${source.kind}:${source.id}:${source.instance_id}`,
      proved[index].custody_wallet_id,
    ])
  );
  return rows.map((row, index) => {
    const payload = { ...row.payload };
    const identity = identities[index];
    let movementKey: string | undefined;
    for (const kind of ["deposit", "withdrawal", "transfer"] as const) {
      const id = identity[movementIdFields[kind]];
      if (id) {
        movementKey = `${kind}:${id}:${row.instance_id}`;
        break;
      }
    }
    if (
      movementKey ||
      "walletId" in payload ||
      "senderWalletId" in payload ||
      "custodyWalletId" in payload
    ) {
      payload.custodyWalletId = movementKey
        ? (sourceLinks.get(movementKey) ?? null)
        : proved[sources.length + index].custody_wallet_id;
    }
    delete payload.walletId;
    delete payload.senderWalletId;
    return { ...row, payload };
  });
}

async function eventsEnvelope(c: AppContext, rows: PrivateChannelEventRow[], hasMore: boolean) {
  const last = rows.at(-1);
  const nextCursor = hasMore && last ? encodeKeysetCursor(last.occurred_at, last.id) : null;
  const auth = getAuth(c);
  const includeRawPayload =
    auth.authType !== "api_key" && callerMayPerform(c, "organizations.manage");
  return success(c, {
    events: (await projectEventCustodyLinks(c, rows)).map((row) =>
      mapPrivateChannelEventRow(row, includeRawPayload)
    ),
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
    viewer,
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
    viewer,
    limit,
    beforeOccurredAt: cursor?.occurredAt,
    beforeId: cursor?.id,
  });

  return eventsEnvelope(c, rows, hasMore);
}
