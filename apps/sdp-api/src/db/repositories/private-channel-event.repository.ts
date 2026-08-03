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
   * Channel feed: events for this channel, plus instance-level events
   * (channel_id IS NULL) so lifecycle like instance.connected appears in the feed.
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
