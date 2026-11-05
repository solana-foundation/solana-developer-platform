"use client";

import type { PrivateChannelInstance } from "@sdp/types/private-channels";
import { Badge } from "@sdp/ui/badge";
import { Card } from "@sdp/ui/card";
import { ChannelTokensPanel } from "@/app/(session)/dashboard/[projectId]/integrations/private-channels/channels/channel-tokens-panel";
import { PrivateChannelsInstanceGate } from "@/app/(session)/dashboard/[projectId]/integrations/private-channels/private-channels-instance-gate";
import { PrivateChannelsLoadError } from "@/app/(session)/dashboard/[projectId]/integrations/private-channels/private-channels-load-error";
import {
  usePrivateChannels,
  usePrivateChannelsCustodyWallets,
  usePrivateChannelTokens,
  usePrivateChannelVerifiedWallets,
} from "@/app/(session)/dashboard/[projectId]/integrations/private-channels/private-channels-reads";
import { PrivateChannelDetailSkeleton } from "@/app/(session)/dashboard/[projectId]/integrations/private-channels/private-channels-route-skeletons";
import { shortenAddress } from "@/app/(session)/dashboard/[projectId]/integrations/private-channels/private-channels-view-data";
import { WalletsTable } from "@/app/(session)/dashboard/[projectId]/integrations/private-channels/wallets/wallets-table";
import ProjectNotFound from "@/app/(session)/dashboard/[projectId]/not-found";
import { useCanWrite } from "@/contexts/dashboard-workspace-context";
import { useTranslations } from "@/i18n/provider";
import { ChannelActionsMenu } from "./channel-actions-menu";

type Translate = ReturnType<typeof useTranslations>;

const ENROLL_WALLET_TRIGGER_ID = "channel-enroll-wallet";

function enrollDisabledReasonOf(
  t: Translate,
  instance: PrivateChannelInstance,
  walletsLoaded: boolean,
  canEnrollWallet: boolean
): string | null {
  if (!instance.isActive) return t("DashboardPrivateChannels.channelDetail.enrollNeedsConnection");
  if (!walletsLoaded) return t("DashboardPrivateChannels.channelDetail.enrollWalletsUnavailable");
  if (!canEnrollWallet) return t("DashboardPrivateChannels.channelDetail.enrollAllWalletsAdded");
  return null;
}

function ChannelDetail({
  instance,
  channelId,
}: {
  instance: PrivateChannelInstance;
  channelId: string;
}) {
  const t = useTranslations();
  // Every item in the actions menu changes the connection, so a read-only member gets none.
  const canWrite = useCanWrite();
  const channels = usePrivateChannels(true);
  const verified = usePrivateChannelVerifiedWallets();
  const custody = usePrivateChannelsCustodyWallets();
  const tokens = usePrivateChannelTokens(true);

  if (channels.data === undefined) {
    return channels.error ? (
      <PrivateChannelsLoadError
        message={channels.error.message}
        onRetry={() => void channels.mutate()}
      />
    ) : (
      <PrivateChannelDetailSkeleton />
    );
  }
  const settled = [verified, custody, tokens].every(
    (read) => read.data !== undefined || read.error !== undefined
  );
  if (!settled) return <PrivateChannelDetailSkeleton />;

  const channel = channels.data.find((item) => item.id === channelId);
  if (channel === undefined) return <ProjectNotFound />;

  const walletsLoaded = verified.data !== undefined && custody.data !== undefined;
  const verifiedWallets = verified.data ?? [];
  const custodyWallets = custody.data ?? [];
  const verifiedPubkeys = new Set(verifiedWallets.map((item) => item.pubkey));
  const canEnrollWallet =
    instance.isActive &&
    walletsLoaded &&
    custodyWallets.some((wallet) => !verifiedPubkeys.has(wallet.publicKey));
  const tokenSummary =
    tokens.data
      ?.filter((token) => token.enabled)
      .map((token) => token.symbol)
      .join(", ") || t("DashboardPrivateChannels.overview.valueNone");
  const walletSummary = walletsLoaded
    ? String(verifiedWallets.length)
    : t("DashboardPrivateChannels.overview.valueNone");

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6" data-private-channel-detail>
      <Card className="gap-0 overflow-hidden py-0">
        <div className="flex flex-col justify-between gap-5 p-6 lg:flex-row lg:items-start">
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="text-3xl font-medium tracking-tight text-primary">{channel.name}</h1>
              <Badge variant={instance.isActive ? "success" : "default"}>
                {instance.isActive
                  ? t("DashboardPrivateChannels.directory.connected")
                  : t("DashboardPrivateChannels.overview.statusNotConnected")}
              </Badge>
            </div>
            <p className="max-w-2xl text-sm leading-6 text-secondary">
              {channel.description || t("DashboardPrivateChannels.channelDetail.description")}
            </p>
          </div>
          {canWrite ? (
            <ChannelActionsMenu
              instance={instance}
              enrollTriggerId={ENROLL_WALLET_TRIGGER_ID}
              canEnrollWallet={canEnrollWallet}
              enrollDisabledReason={enrollDisabledReasonOf(
                t,
                instance,
                walletsLoaded,
                canEnrollWallet
              )}
            />
          ) : null}
        </div>

        <dl className="grid gap-px border-border-default border-t bg-border-default sm:grid-cols-2 lg:grid-cols-4">
          <div className="min-w-0 bg-surface-raised px-6 py-4">
            <dt className="text-xs text-tertiary">
              {t("DashboardPrivateChannels.instance.gatewayUrl")}
            </dt>
            <dd className="mt-1 truncate text-sm text-primary" title={instance.gatewayUrl}>
              {instance.gatewayUrl}
            </dd>
          </div>
          <div className="min-w-0 bg-surface-raised px-6 py-4">
            <dt className="text-xs text-tertiary">
              {t("DashboardPrivateChannels.instance.escrowInstanceAddr")}
            </dt>
            <dd className="mt-1 truncate text-sm text-primary" title={instance.escrowInstanceAddr}>
              {shortenAddress(instance.escrowInstanceAddr, 8)}
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
        loadError={!walletsLoaded}
        onRetry={() => {
          if (verified.error !== undefined) void verified.mutate();
          if (custody.error !== undefined) void custody.mutate();
        }}
        showBalance={false}
        enrollTriggerId={ENROLL_WALLET_TRIGGER_ID}
        canWrite={canWrite}
      />

      <ChannelTokensPanel
        channelName={channel.name}
        tokens={tokens.data ?? []}
        loadError={tokens.data === undefined}
      />
    </div>
  );
}

export function PrivateChannelDetail({
  instanceId,
  channelId,
}: {
  instanceId: string;
  channelId: string;
}) {
  return (
    <PrivateChannelsInstanceGate
      match={{ instanceId, requireActive: false }}
      skeleton={<PrivateChannelDetailSkeleton />}
    >
      {(instance) => <ChannelDetail instance={instance} channelId={channelId} />}
    </PrivateChannelsInstanceGate>
  );
}
