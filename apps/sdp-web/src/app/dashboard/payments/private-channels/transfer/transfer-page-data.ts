import type {
  CustodyWalletSummary,
  PrivateChannelDto,
  PrivateChannelMembershipChannelDto,
  PrivateChannelVerifiedWalletDto,
} from "@sdp/types";

export function createTransferScopeKey(
  organizationId: string,
  projectId: string,
  instanceId: string
): string {
  return `${organizationId}:${projectId}:${instanceId}`;
}

/** Preserve caller membership order while excluding channels outside the active instance. */
export function intersectEligibleTransferChannels(
  memberships: PrivateChannelMembershipChannelDto[],
  activeChannels: PrivateChannelDto[]
): PrivateChannelMembershipChannelDto[] {
  const activeChannelIds = new Set(activeChannels.map((channel) => channel.id));
  return memberships.filter((membership) => activeChannelIds.has(membership.id));
}

/** Strict walletId + pubkey intersection prevents stale or other-user sources. */
export function intersectVerifiedSourceWallets(
  signableWallets: CustodyWalletSummary[],
  actingUserVerifiedWallets: PrivateChannelVerifiedWalletDto[]
): CustodyWalletSummary[] {
  const verified = new Set(
    actingUserVerifiedWallets.map((wallet) => `${wallet.walletId}\0${wallet.pubkey}`)
  );
  return signableWallets.filter((wallet) =>
    verified.has(`${wallet.walletId}\0${wallet.publicKey}`)
  );
}
