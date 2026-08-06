import type { PrivateChannelEventViewerScope } from "./private-channel-event.repository";

export interface PrivateChannelReferenceRow {
  kind: "channel" | "wallet" | "member" | "instance" | "token";
  key: string;
  name: string;
}

export type PrivateChannelReferenceWalletScope =
  | { scope: "all" }
  | { scope: "selected"; walletIds: string[] }
  | { scope: "none" };

export interface ListPrivateChannelReferencesParams {
  organizationId: string;
  projectId: string;
  /**
   * Wallet visibility after applying wallets:read and API-key wallet bindings.
   */
  walletScope: PrivateChannelReferenceWalletScope;
  /**
   * Event viewer scope. Members resolve only their channels and co-members
   * (plus themselves), and resolve instances only when they have a channel.
   */
  viewer: PrivateChannelEventViewerScope;
}

export interface PrivateChannelReferenceRepository {
  /**
   * Project-scoped display-name dictionary for event enrichment. One query
   * covering channel names, member names (keyed by private-channel-user id and
   * SDP user id), issued-token symbols (keyed by mint), authorized custody
   * wallet labels (keyed by pubkey and wallet_id), and instance gateway URLs
   * for viewers who can see instance lifecycle events.
   */
  listReferences(params: ListPrivateChannelReferencesParams): Promise<PrivateChannelReferenceRow[]>;
}
