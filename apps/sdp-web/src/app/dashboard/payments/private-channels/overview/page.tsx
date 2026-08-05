import { redirect } from "next/navigation";
import { createSdpApiClient } from "@/lib/sdp-api";
import {
  PRIVATE_CHANNELS_INSTANCE_PATH,
  requirePrivateChannelsAccess,
} from "../private-channels-access";
import { PrivateChannelsLoadError } from "../private-channels-load-error";
import {
  loadChannelBalances,
  loadChannels,
  loadEvents,
  loadOverview,
  loadWalletVerification,
} from "../private-channels-page.data";
import { AllowedTokensPanel } from "./allowed-tokens-panel";
import { ConnectedInstancePanel } from "./connected-instance-panel";
import { channelNameById } from "./overview-data";
import { PrivateBalancePanel } from "./private-balance-panel";
import { RecentActivityPanel } from "./recent-activity-panel";

export default async function PrivateChannelsOverviewPage() {
  await requirePrivateChannelsAccess();

  const client = await createSdpApiClient();
  const [overview, wallets, channels, events] = await Promise.all([
    loadOverview(client),
    loadWalletVerification(client),
    loadChannels(client),
    loadEvents(client),
  ]);

  // `ok` with no data is the expected "no active instance" 404 — route to connect.
  if (overview.ok && !overview.data) {
    redirect(PRIVATE_CHANNELS_INSTANCE_PATH);
  }
  // A genuine overview failure: keep the user here and surface the error.
  if (!overview.data) {
    return <PrivateChannelsLoadError message={overview.error} />;
  }

  // Channel balances only exist for verified wallets — unverified reads would 403.
  const channelBalances = wallets.ok
    ? await loadChannelBalances(client, wallets.data.verified)
    : {};

  return (
    // Payments routes are viewport-locked (see dashboard-shell): the page renders in
    // an `overflow-hidden flex-1` container with the shell's usual `px-3 py-5 md:p-6`
    // padding dropped. So this page (1) re-adds that padding — a full-bleed layout
    // gets no side gutter from `mx-auto max-w-*` centering the way narrow siblings do —
    // and (2) is a full-height flex column: the summary row stays fixed while the
    // activity panel fills the remaining height and scrolls internally, instead of
    // overflowing below the locked viewport.
    <div className="flex h-full min-h-0 w-full flex-col gap-4 px-3 py-5 md:p-6">
      <div className="grid shrink-0 grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <ConnectedInstancePanel
          instance={overview.data.instance}
          overview={overview.data.overview}
        />
        <PrivateBalancePanel channelBalances={channelBalances} />
        <AllowedTokensPanel instance={overview.data.instance} />
      </div>

      <RecentActivityPanel
        initialEvents={events.data.events}
        channelNames={channelNameById(channels.data)}
      />
    </div>
  );
}
