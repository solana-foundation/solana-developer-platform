export interface PrivateChannelReferenceRow {
  kind: "channel" | "wallet" | "member" | "instance" | "token";
  key: string;
  name: string;
}

export interface ListPrivateChannelReferencesParams {
  organizationId: string;
  projectId: string;
  /**
   * Member-scoped viewer. When set, channels and members are narrowed to the
   * viewer's channels and co-members (plus themselves), and instances are
   * dropped. Omit for full viewers. Mirrors ListProjectPrivateChannelEventsParams.
   */
  viewer?: { channelIds: string[]; userId: string };
}

export interface PrivateChannelReferenceRepository {
  /**
   * Project-scoped display-name dictionary for event enrichment. One query
   * covering channel names, custody wallet labels (keyed by pubkey and
   * wallet_id), member names (keyed by private-channel-user id and SDP user
   * id), issued-token symbols (keyed by mint), and — for full viewers only —
   * instance gateway URLs.
   */
  listReferences(params: ListPrivateChannelReferencesParams): Promise<PrivateChannelReferenceRow[]>;
}
