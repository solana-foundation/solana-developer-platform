import { createSdpApiClient, getSelectedProjectId } from "@/lib/sdp-api";
import { requirePrivateChannelsAccess } from "../private-channels-access";
import { loadChannelBalances, loadWalletVerification } from "../private-channels-page.data";
import { WalletsTable } from "./wallets-table";

export default async function PrivateChannelsWalletsPage() {
  await requirePrivateChannelsAccess();

  // The same request-scoped resolution the client used: the project this page's
  // wallet data was loaded under. The table's verify/revoke actions re-bind to
  // it instead of the mutable selection cookie, so a sibling tab that moves the
  // cookie between render and submit can never persist under another project.
  const [client, projectId] = await Promise.all([createSdpApiClient(), getSelectedProjectId()]);
  if (!projectId) {
    throw new Error("Selected project required");
  }
  const wallets = await loadWalletVerification(client);

  // Channel balances only exist for verified wallets — unverified reads would 403.
  const channelBalances = wallets.ok
    ? await loadChannelBalances(client, wallets.data.verified)
    : {};

  return (
    <div className="mx-auto w-full max-w-5xl">
      <WalletsTable
        projectId={projectId}
        verifiedWallets={wallets.ok ? wallets.data.verified : []}
        custodyWallets={wallets.ok ? wallets.data.custody : []}
        channelBalances={channelBalances}
        loadError={!wallets.ok}
      />
    </div>
  );
}
