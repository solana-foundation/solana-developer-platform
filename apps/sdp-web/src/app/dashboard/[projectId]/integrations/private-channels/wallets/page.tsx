import { requirePrivateChannelsAccess } from "@/app/dashboard/[projectId]/integrations/private-channels/private-channels-access";
import {
  loadChannelBalances,
  loadWalletVerification,
} from "@/app/dashboard/[projectId]/integrations/private-channels/private-channels-page.data";
import { createSdpApiClient } from "@/lib/sdp-api";
import { WalletsTable } from "./wallets-table";

export default async function PrivateChannelsWalletsPage() {
  await requirePrivateChannelsAccess();

  const client = await createSdpApiClient();
  const wallets = await loadWalletVerification(client);

  // Channel balances only exist for verified wallets — unverified reads would 403.
  const channelBalances = wallets.ok
    ? await loadChannelBalances(client, wallets.data.verified)
    : {};

  return (
    <div className="mx-auto w-full max-w-5xl">
      <WalletsTable
        verifiedWallets={wallets.ok ? wallets.data.verified : []}
        custodyWallets={wallets.ok ? wallets.data.custody : []}
        channelBalances={channelBalances}
        loadError={!wallets.ok}
      />
    </div>
  );
}
