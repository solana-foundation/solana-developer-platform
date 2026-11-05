"use client";

import {
  usePrivateChannelBalances,
  usePrivateChannelsCustodyWallets,
  usePrivateChannelVerifiedWallets,
} from "@/app/(session)/dashboard/[projectId]/integrations/private-channels/private-channels-reads";
import { PrivateChannelsListSkeleton } from "@/app/(session)/dashboard/[projectId]/integrations/private-channels/private-channels-route-skeletons";
import { useCanWrite } from "@/contexts/dashboard-workspace-context";
import { WalletsTable } from "./wallets-table";

export function WalletsSection() {
  const canWrite = useCanWrite();
  const verified = usePrivateChannelVerifiedWallets();
  const custody = usePrivateChannelsCustodyWallets();
  // Channel balances only exist for verified wallets: unverified reads would 403.
  const balances = usePrivateChannelBalances(
    verified.data === undefined ? null : verified.data.map((wallet) => wallet.pubkey)
  );
  const walletsLoaded = verified.data !== undefined && custody.data !== undefined;
  const walletsFailed = verified.error !== undefined || custody.error !== undefined;
  const balancesSettled = verified.data?.length === 0 || balances.data !== undefined;

  if (walletsLoaded ? !balancesSettled : !walletsFailed) {
    return <PrivateChannelsListSkeleton maxWidth="max-w-5xl" />;
  }
  return (
    <div className="mx-auto w-full max-w-5xl">
      <WalletsTable
        verifiedWallets={verified.data ?? []}
        custodyWallets={custody.data ?? []}
        channelBalances={balances.data ?? {}}
        loadError={!walletsLoaded}
        onRetry={() => {
          if (verified.error !== undefined) void verified.mutate();
          if (custody.error !== undefined) void custody.mutate();
        }}
        canWrite={canWrite}
      />
    </div>
  );
}
