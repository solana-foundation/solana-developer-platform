import {
  fetchActiveApiKeys,
  resolvePlaygroundApiBaseUrl,
} from "@/app/dashboard/playground-api-data";
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
import { PrivateChannelsPlayground } from "./private-channels-playground";
import { PrivateChannelsTabShell } from "./private-channels-tab-shell";
import { RecentActivityPanel } from "./recent-activity-panel";

export default async function PrivateChannelsOverviewPage() {
  await requirePrivateChannelsAccess();

  // The API Playground renders here too, as the Overview's `?tab=playground`
  // pane, so switching tabs is a shallow history update instead of a segment
  // navigation that refetches the RSC payload on every toggle.
  const client = await createSdpApiClient();
  const [overview, wallets, channels, events, apiKeysResult] = await Promise.all([
    loadOverview(client),
    loadWalletVerification(client),
    loadChannels(client),
    loadEvents(client),
    fetchActiveApiKeys(client.request),
  ]);

  // The old /api-playground segment gave the playground a definite flex height
  // below the tab strip; its pane keeps that contract so the playground owns its
  // internal request/response scrolling instead of growing beyond the viewport.
  const playgroundPane = (
    <div className="flex min-h-0 w-full flex-1 flex-col">
      <PrivateChannelsPlayground
        apiBaseUrl={resolvePlaygroundApiBaseUrl()}
        apiKeys={apiKeysResult.data ?? []}
      />
    </div>
  );

  // The overview always renders — even with no connected instance, in which case it
  // shows the "Not connected" state and a connect link. Only a genuine load failure
  // (not the expected "no active instance" 404, which resolves to ok+null data) keeps
  // the user on an error screen.
  // Channels feed both the connected-instance summary and activity labels, so their
  // fallback cannot produce a truthful partial page. Surface that failure just like
  // the overview request instead of presenting missing channel data as an empty state.
  // The playground pane never needed overview data, so it stays reachable either way.
  if (!overview.ok || !channels.ok) {
    return (
      <PrivateChannelsTabShell
        overview={<PrivateChannelsLoadError message={overview.error ?? channels.error} />}
        playground={playgroundPane}
      />
    );
  }
  const instance = overview.data?.instance ?? null;
  const instanceOverview = overview.data?.overview ?? null;
  const isConnected = instance !== null;
  const defaultChannelName = channels.data.find((channel) => channel.isDefault)?.name ?? null;

  // Channel balances only exist for verified wallets — unverified reads would 403.
  const channelBalances = wallets.ok
    ? await loadChannelBalances(client, wallets.data.verified)
    : {};

  const overviewPane = (
    // The segment layout owns viewport scrolling and gutters. Keep this pane height-bound
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

  return <PrivateChannelsTabShell overview={overviewPane} playground={playgroundPane} />;
}
