import { createProjectBoundSdpApiClient } from "@/lib/sdp-api";
import { requirePrivateChannelsAccess } from "../private-channels-access";
import { loadChannelBalances, loadWalletVerification } from "../private-channels-page.data";
import { WalletsTable } from "./wallets-table";

export default async function PrivateChannelsWalletsPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  await requirePrivateChannelsAccess();
  const { projectId } = await params;

  const client = await createProjectBoundSdpApiClient(projectId);
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
