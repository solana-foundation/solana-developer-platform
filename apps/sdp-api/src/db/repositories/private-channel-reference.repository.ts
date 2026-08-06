export interface PrivateChannelReferenceRow {
  kind: "channel" | "wallet" | "member" | "instance" | "token";
  key: string;
  name: string;
}

export interface ListPrivateChannelReferencesParams {
  organizationId: string;
  projectId: string;
  /**
   * Whether the caller holds wallets:read. Custody labels, wallet ids, and
   * pubkeys are only readable behind that permission, and a caller can hold
   * payments:read without it, so the wallet branch is opt-in.
   */
  includeWalletLabels: boolean;
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
   * covering channel names, member names (keyed by private-channel-user id and
   * SDP user id), issued-token symbols (keyed by mint), custody wallet labels
   * when the caller holds wallets:read (keyed by pubkey and wallet_id), and —
   * for full viewers only — instance gateway URLs.
   */
  listReferences(params: ListPrivateChannelReferencesParams): Promise<PrivateChannelReferenceRow[]>;
}
