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
import { shortenAddress } from "../../../private-channels-view-data";
import { WalletsTable } from "../../../wallets/wallets-table";
import { ChannelActionsMenu } from "./channel-actions-menu";

type Translate = Awaited<ReturnType<typeof getTranslations>>;
type SdpClient = Awaited<ReturnType<typeof createSdpApiClient>>;

async function loadPrivateChannelDetail(
  instanceId: string,
  channelId: string,
  t: Translate,
  client: SdpClient
) {
  const [instance, channels, wallets, tokens] = await Promise.all([
    loadInstance(client),
    loadChannels(client),
    loadWalletVerification(client),
    loadTokenEligibility(client),
  ]);

  if (!instance.ok) return { ok: false, error: instance.error } as const;
  const activeInstance = instance.data;
  if (!activeInstance || activeInstance.id !== instanceId) notFound();
  if (!channels.ok) return { ok: false, error: channels.error } as const;

  const channel = channels.data.find((item) => item.id === channelId);
  if (!channel) notFound();

  const verifiedWallets = wallets.ok ? wallets.data.verified : [];
  const custodyWallets = wallets.ok ? wallets.data.custody : [];
  const verifiedPubkeys = new Set(verifiedWallets.map((item) => item.pubkey));
  const canEnrollWallet =
    activeInstance.isActive &&
    wallets.ok &&
    custodyWallets.some((wallet) => !verifiedPubkeys.has(wallet.publicKey));
  let enrollDisabledReason: string | null = null;
  if (!activeInstance.isActive) {
    enrollDisabledReason = t("DashboardPrivateChannels.channelDetail.enrollNeedsConnection");
  } else if (!wallets.ok) {
    enrollDisabledReason = t("DashboardPrivateChannels.channelDetail.enrollWalletsUnavailable");
  } else if (!canEnrollWallet) {
    enrollDisabledReason = t("DashboardPrivateChannels.channelDetail.enrollAllWalletsAdded");
  }

  const allowedTokens = tokens.ok ? tokens.data.filter((token) => token.enabled) : [];
  const tokenSummary = tokens.ok
    ? allowedTokens.map((token) => token.symbol).join(", ") ||
      t("DashboardPrivateChannels.overview.valueNone")
    : t("DashboardPrivateChannels.overview.valueNone");

  return {
    ok: true,
    data: {
      activeInstance,
      tokens: tokens.ok ? tokens.data : [],
      canEnrollWallet,
      channel,
      custodyWallets,
      enrollDisabledReason,
      loadTokensError: !tokens.ok,
      loadWalletsError: !wallets.ok,
      tokenSummary,
      verifiedWallets,
      walletSummary: wallets.ok
        ? String(verifiedWallets.length)
        : t("DashboardPrivateChannels.overview.valueNone"),
    },
  } as const;
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
  const result = await loadPrivateChannelDetail(instanceId, channelId, t, client);
  if (!result.ok) return <PrivateChannelsLoadError message={result.error} />;

  const enrollWalletTriggerId = "channel-enroll-wallet";
  const {
    activeInstance,
    canEnrollWallet,
    channel,
    custodyWallets,
    enrollDisabledReason,
    loadTokensError,
    loadWalletsError,
    tokenSummary,
    tokens,
    verifiedWallets,
    walletSummary,
  } = result.data;

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
              {shortenAddress(activeInstance.escrowInstanceAddr, 8)}
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
        verifiedWallets={verifiedWallets}
        custodyWallets={custodyWallets}
        channelBalances={{}}
        loadError={loadWalletsError}
        showBalance={false}
        enrollTriggerId={enrollWalletTriggerId}
      />

      <ChannelTokensPanel channelName={channel.name} tokens={tokens} loadError={loadTokensError} />
    </div>
  );
}
