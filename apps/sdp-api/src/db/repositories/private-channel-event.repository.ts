import type {
  PrivateChannelEventFamily,
  PrivateChannelEventStatus,
  PrivateChannelEventType,
} from "@sdp/types";
import type { RepositoryDbClient } from "./base";

export function generatePrivateChannelEventId(): string {
  return `pce_${crypto.randomUUID()}`;
}

export interface PrivateChannelEventRow {
  id: string;
  organization_id: string;
  project_id: string;
  instance_id: string;
  channel_id: string | null;
  sdp_user_id: string | null;
  family: PrivateChannelEventFamily;
  type: PrivateChannelEventType;
  status: PrivateChannelEventStatus;
  payload: Record<string, unknown>;
  occurred_at: string;
  created_at: string;
}

export interface PrivateChannelEventWriteInput {
  id: string;
  organizationId: string;
  projectId: string;
  instanceId: string;
  channelId: string | null;
  sdpUserId: string | null;
  family: PrivateChannelEventFamily;
  type: PrivateChannelEventType;
  status: PrivateChannelEventStatus;
  payload: Record<string, unknown>;
  occurredAt: string;
  createdAt: string;
}

export interface ListPrivateChannelEventsParams {
  channelId: string;
  instanceId: string;
  family?: PrivateChannelEventFamily;
  type?: string;
  status?: PrivateChannelEventStatus;
  /**
   * Member-scoped viewer. When set, channel-less events are narrowed to
   * lifecycle events plus events this SDP user authored. Omit for full viewers.
   */
  viewerUserId?: string;
  /** Capped at 100 by callers. */
  limit: number;
  /** Cursor: occurred_at of the last row from the previous page. */
  beforeOccurredAt?: string;
  /** Cursor tiebreaker: id of the last row from the previous page. */
  beforeId?: string;
}

export interface ListProjectPrivateChannelEventsParams {
  organizationId: string;
  projectId: string;
  family?: PrivateChannelEventFamily;
  type?: string;
  status?: PrivateChannelEventStatus;
  /**
   * Member-scoped viewer. When set, the feed is narrowed to the member's
   * channels plus the channel-less events this SDP user authored, and to
   * channel-less lifecycle events once they belong to at least one channel.
   * Omit for full viewers.
   */
  viewer?: { channelIds: string[]; userId: string };
  /** Capped at 100 by callers. */
  limit: number;
  /** Cursor: occurred_at of the last row from the previous page. */
  beforeOccurredAt?: string;
  /** Cursor tiebreaker: id of the last row from the previous page. */
  beforeId?: string;
}

export interface PrivateChannelEventRepositoryContext {
  db: RepositoryDbClient;
}

export interface PrivateChannelEventRepository {
  insert(input: PrivateChannelEventWriteInput): Promise<PrivateChannelEventRow>;
  /**
   * Channel feed: events for this channel, plus non-transfer instance-level
   * events so lifecycle like instance.connected appears without pulling unrelated
   * channel-less financial events into every channel. Member viewers only see
   * the channel-less events they authored, alongside lifecycle.
   */
  listByChannel(
    params: ListPrivateChannelEventsParams
  ): Promise<{ rows: PrivateChannelEventRow[]; hasMore: boolean }>;
  /**
   * Project feed: every event for the project regardless of instance/channel.
   * Instance-independent (survives instance deletion), so this is the durable
   * history read path.
   */
  listByProject(
    params: ListProjectPrivateChannelEventsParams
  ): Promise<{ rows: PrivateChannelEventRow[]; hasMore: boolean }>;
}
