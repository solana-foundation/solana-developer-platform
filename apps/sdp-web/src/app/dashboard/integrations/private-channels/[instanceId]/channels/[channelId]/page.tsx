import { notFound } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { getTranslations } from "@/i18n/server";
import { createSdpApiClient } from "@/lib/sdp-api";
import { ChannelTokensPanel } from "../../../channels/channel-tokens-panel";
import { requirePrivateChannelsAccess } from "../../../private-channels-access";
import { PrivateChannelsLoadError } from "../../../private-channels-load-error";
import {
  loadChannels,
  loadInstance,
  loadTokenEligibility,
  loadWalletVerification,
} from "../../../private-channels-page.data";
import { WalletsTable } from "../../../wallets/wallets-table";
import { ChannelActionsMenu } from "./channel-actions-menu";

function shorten(value: string): string {
  return value.length > 19 ? `${value.slice(0, 8)}…${value.slice(-8)}` : value;
}

export default async function PrivateChannelDetailPage({
  params,
}: {
  params: Promise<{ instanceId: string; channelId: string }>;
}) {
  await requirePrivateChannelsAccess();

  const [{ instanceId, channelId }, t, client] = await Promise.all([
    params,
    getTranslations(),
    createSdpApiClient(),
  ]);
  const [instance, channels, wallets, tokens] = await Promise.all([
    loadInstance(client),
    loadChannels(client),
    loadWalletVerification(client),
    loadTokenEligibility(client),
  ]);

  if (!instance.ok) return <PrivateChannelsLoadError message={instance.error} />;
  const activeInstance = instance.data;
  if (!activeInstance || activeInstance.id !== instanceId) notFound();
  if (!channels.ok) return <PrivateChannelsLoadError message={channels.error} />;

  const channel = channels.data.find((item) => item.id === channelId);
  if (!channel) notFound();

  const enrollWalletTriggerId = "channel-enroll-wallet";
  const verifiedPubkeys = new Set(
    wallets.ok ? wallets.data.verified.map((item) => item.pubkey) : []
  );
  const canEnrollWallet =
    activeInstance.isActive &&
    wallets.ok &&
    wallets.data.custody.some((wallet) => !verifiedPubkeys.has(wallet.publicKey));
  const enrollDisabledReason = !activeInstance.isActive
    ? t("DashboardPrivateChannels.channelDetail.enrollNeedsConnection")
    : !wallets.ok
      ? t("DashboardPrivateChannels.channelDetail.enrollWalletsUnavailable")
      : canEnrollWallet
        ? null
        : t("DashboardPrivateChannels.channelDetail.enrollAllWalletsAdded");
  const allowedTokens = tokens.ok ? tokens.data.filter((token) => token.enabled) : [];
  const tokenSummary = tokens.ok
    ? allowedTokens.map((token) => token.symbol).join(", ") ||
      t("DashboardPrivateChannels.overview.valueNone")
    : t("DashboardPrivateChannels.overview.valueNone");
  const walletSummary = wallets.ok
    ? String(wallets.data.verified.length)
    : t("DashboardPrivateChannels.overview.valueNone");

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6" data-private-channel-detail>
      <Card className="gap-0 overflow-hidden py-0">
        <div className="flex flex-col justify-between gap-5 p-6 lg:flex-row lg:items-start">
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="text-3xl font-medium tracking-tight text-primary">{channel.name}</h1>
              <Badge variant={activeInstance.isActive ? "success" : "default"}>
                {activeInstance.isActive
                  ? t("DashboardPrivateChannels.directory.connected")
                  : t("DashboardPrivateChannels.overview.statusNotConnected")}
              </Badge>
            </div>
            <p className="max-w-2xl text-sm leading-6 text-secondary">
              {channel.description || t("DashboardPrivateChannels.channelDetail.description")}
            </p>
          </div>
          <ChannelActionsMenu
            instance={activeInstance}
            enrollTriggerId={enrollWalletTriggerId}
            canEnrollWallet={canEnrollWallet}
            enrollDisabledReason={enrollDisabledReason}
          />
        </div>

        <dl className="grid gap-px border-border-default border-t bg-border-default sm:grid-cols-2 lg:grid-cols-4">
          <div className="min-w-0 bg-surface-raised px-6 py-4">
            <dt className="text-xs text-tertiary">
              {t("DashboardPrivateChannels.instance.gatewayUrl")}
            </dt>
            <dd className="mt-1 truncate text-sm text-primary" title={activeInstance.gatewayUrl}>
              {activeInstance.gatewayUrl}
            </dd>
          </div>
          <div className="min-w-0 bg-surface-raised px-6 py-4">
            <dt className="text-xs text-tertiary">
              {t("DashboardPrivateChannels.instance.escrowInstanceAddr")}
            </dt>
            <dd
              className="mt-1 truncate text-sm text-primary"
              title={activeInstance.escrowInstanceAddr}
            >
              {shorten(activeInstance.escrowInstanceAddr)}
            </dd>
          </div>
          <div className="min-w-0 bg-surface-raised px-6 py-4">
            <dt className="text-xs text-tertiary">
              {t("DashboardPrivateChannels.overview.walletsTitle")}
            </dt>
            <dd className="mt-1 text-sm text-primary">{walletSummary}</dd>
          </div>
          <div className="min-w-0 bg-surface-raised px-6 py-4">
            <dt className="text-xs text-tertiary">
              {t("DashboardPrivateChannels.overview.allowedTokensTitle")}
            </dt>
            <dd className="mt-1 truncate text-sm text-primary" title={tokenSummary}>
              {tokenSummary}
            </dd>
          </div>
        </dl>
      </Card>

      <WalletsTable
        verifiedWallets={wallets.ok ? wallets.data.verified : []}
        custodyWallets={wallets.ok ? wallets.data.custody : []}
        channelBalances={{}}
        loadError={!wallets.ok}
        showBalance={false}
        enrollTriggerId={enrollWalletTriggerId}
      />

      <ChannelTokensPanel channelName={channel.name} tokens={tokens.data} loadError={!tokens.ok} />
    </div>
  );
}
