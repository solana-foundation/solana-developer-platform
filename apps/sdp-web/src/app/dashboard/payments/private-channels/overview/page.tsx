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
  // Channels feed both the connected-instance summary and activity labels, so their
  // fallback cannot produce a truthful partial page. Surface that failure just like
  // the overview request instead of presenting missing channel data as an empty state.
  if (!overview.ok || !channels.ok) {
    return <PrivateChannelsLoadError message={overview.error ?? channels.error} />;
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
    // The segment layout owns viewport scrolling and gutters. Keep this page height-bound
    // so the summary panels take their natural height while the activity panel fills the
    // remainder and scrolls only its table, leaving the "View all" footer pinned in view.
    <div className="flex h-full min-h-0 w-full flex-col gap-4">
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
