import { createSdpApiClient } from "@/lib/sdp-api";
import { requirePrivateChannelsAccess } from "../private-channels-access";
import { PrivateChannelsLoadError } from "../private-channels-load-error";
import {
  loadChannelBalances,
  loadChannels,
  loadEvents,
  loadOverview,
  loadWalletVerification,
} from "../private-channels-page.data";
import {
  PRIVATE_CHANNELS_CHANNELS_PATH,
  PRIVATE_CHANNELS_INSTANCE_PATH,
  PRIVATE_CHANNELS_WALLETS_PATH,
} from "../private-channels-routes";
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

  // The overview always renders — even with no connected instance, in which case it
  // shows the "Not connected" state and a connect link. Only a genuine load failure
  // (not the expected "no active instance" 404, which resolves to ok+null data) keeps
  // the user on an error screen.
  if (!overview.ok) {
    return <PrivateChannelsLoadError message={overview.error} />;
  }
  const instance = overview.data?.instance ?? null;
  const instanceOverview = overview.data?.overview ?? null;
  const isConnected = instance !== null;
  const defaultChannelName = channels.data.find((channel) => channel.isDefault)?.name ?? null;

  // Channel balances only exist for verified wallets — unverified reads would 403.
  const channelBalances = wallets.ok
    ? await loadChannelBalances(client, wallets.data.verified)
    : {};

  return (
    // Payments routes are viewport-locked (see dashboard-shell): the page renders in an
    // `overflow-hidden` box with the shell's usual padding dropped. So this full-bleed page
    // re-adds side/bottom padding and lays out as a flex column — the summary panels take
    // their natural height and the activity panel fills the remaining space, scrolling its
    // own table so its "View all" footer stays pinned in view. Top padding is trimmed since
    // the header tabs already sit just above.
    <div className="flex h-full min-h-0 w-full flex-col gap-4 overflow-y-auto px-3 pt-2 pb-5 md:px-6 md:pb-6">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <ConnectedInstancePanel
          instance={instance}
          overview={instanceOverview}
          connectHref={PRIVATE_CHANNELS_INSTANCE_PATH}
          instanceHref={PRIVATE_CHANNELS_INSTANCE_PATH}
          channelsHref={PRIVATE_CHANNELS_CHANNELS_PATH}
          defaultChannelName={defaultChannelName}
        />
        <PrivateBalancePanel
          channelBalances={channelBalances}
          walletsHref={PRIVATE_CHANNELS_WALLETS_PATH}
          connected={isConnected}
          loadError={!wallets.ok}
        />
        <AllowedTokensPanel instance={instance} />
      </div>

      {/* Activity only exists once an instance is connected — hide the panel until then. */}
      {isConnected ? (
        <RecentActivityPanel
          initialEvents={events.data.events}
          channelNames={channelNameById(channels.data)}
          loadError={!events.ok}
        />
      ) : null}
    </div>
  );
}
