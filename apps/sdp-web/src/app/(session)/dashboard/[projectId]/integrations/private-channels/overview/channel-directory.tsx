"use client";

import type {
  PrivateChannelDto,
  PrivateChannelInstance,
  PrivateChannelPrincipalDto,
  PrivateChannelTokenEligibility,
} from "@sdp/types/private-channels";
import { Button } from "@sdp/ui/button";
import { SkeletonBlock } from "@sdp/ui/skeleton-block";
import { TableCell } from "@sdp/ui/table";
import { Table, TableBody, TableHead, TableHeader, TableRow } from "@solana/design-system/table";
import Link from "next/link";
import { PrivateChannelsLoadError } from "@/app/(session)/dashboard/[projectId]/integrations/private-channels/private-channels-load-error";
import {
  usePrivateChannelInstance,
  usePrivateChannelPrincipals,
  usePrivateChannels,
  usePrivateChannelTokens,
} from "@/app/(session)/dashboard/[projectId]/integrations/private-channels/private-channels-reads";
import { PrivateChannelsOverviewSkeleton } from "@/app/(session)/dashboard/[projectId]/integrations/private-channels/private-channels-route-skeletons";
import { PRIVATE_CHANNELS_SETUP_PATH } from "@/app/(session)/dashboard/[projectId]/integrations/private-channels/private-channels-routes";
import {
  enabledTokenSymbols,
  shortenAddress,
} from "@/app/(session)/dashboard/[projectId]/integrations/private-channels/private-channels-view-data";
import ProjectNotFound from "@/app/(session)/dashboard/[projectId]/not-found";
import { DashboardWorkspaceCard } from "@/components/dashboard-workspace-panel";
import { useCanWrite } from "@/contexts/dashboard-workspace-context";
import { useTranslations } from "@/i18n/provider";
import { useProjectHref } from "@/lib/use-dashboard-project";
import { ChannelDirectoryRow } from "./channel-directory-row";
import { CreateChannelButton } from "./create-channel-button";

type Translate = ReturnType<typeof useTranslations>;

function tokensSummaryOf(tokens: PrivateChannelTokenEligibility[] | null, t: Translate): string {
  if (tokens === null) return t("DashboardPrivateChannels.directory.tokensUnavailable");
  const symbols = enabledTokenSymbols(tokens);
  return symbols.length > 0 ? symbols.join(", ") : t("DashboardPrivateChannels.directory.noTokens");
}

/** Wallets enrolled in the channel through its active principals; `null` when principals failed. */
function walletCountOf(
  channel: PrivateChannelDto,
  principals: PrivateChannelPrincipalDto[] | null
): number | null {
  if (principals === null) return null;
  let walletCount = 0;
  for (const principal of principals) {
    const belongsToChannel = principal.channels.some((membership) => membership.id === channel.id);
    if (principal.status === "active" && belongsToChannel) {
      walletCount += principal.verifiedWalletCount;
    }
  }
  return walletCount;
}

/**
 * The directory header's action: none for a read-only member, a new channel once an instance is
 * connected, else the way to connect one.
 */
function ChannelHeaderAction({ activeInstanceId }: { activeInstanceId: string | null }) {
  const t = useTranslations();
  const href = useProjectHref();
  const canWrite = useCanWrite();
  if (!canWrite) return null;
  if (activeInstanceId !== null) return <CreateChannelButton instanceId={activeInstanceId} />;
  return (
    <Button asChild>
      <Link href={href(PRIVATE_CHANNELS_SETUP_PATH)}>
        {t("DashboardPrivateChannels.directory.setupChannel")}
      </Link>
    </Button>
  );
}

const SKELETON_ROW_IDS = ["pc-directory-row-1", "pc-directory-row-2", "pc-directory-row-3"];

function DirectoryRowsSkeleton() {
  return SKELETON_ROW_IDS.map((id) => (
    <TableRow key={id}>
      <TableCell colSpan={6}>
        <SkeletonBlock className="h-5 w-full" />
      </TableCell>
    </TableRow>
  ));
}

function DirectoryRows({ activeInstance }: { activeInstance: PrivateChannelInstance }) {
  const t = useTranslations();
  const channels = usePrivateChannels(true);
  const principals = usePrivateChannelPrincipals(true);
  const tokens = usePrivateChannelTokens(true);

  if (channels.data === undefined) {
    return channels.error ? (
      <TableRow>
        <TableCell colSpan={6}>
          <PrivateChannelsLoadError
            message={channels.error.message}
            onRetry={() => void channels.mutate()}
          />
        </TableCell>
      </TableRow>
    ) : (
      <DirectoryRowsSkeleton />
    );
  }
  const principalsSettled = principals.data !== undefined || principals.error !== undefined;
  const tokensSettled = tokens.data !== undefined || tokens.error !== undefined;
  if (!principalsSettled || !tokensSettled) return <DirectoryRowsSkeleton />;

  if (channels.data.length === 0) {
    return (
      <TableRow>
        <TableCell className="py-12 text-center text-secondary" colSpan={6}>
          {t("DashboardPrivateChannels.directory.empty")}
        </TableCell>
      </TableRow>
    );
  }
  const tokensSummary = tokensSummaryOf(tokens.data ?? null, t);
  const instanceLabel = shortenAddress(activeInstance.escrowInstanceAddr, 6);
  return channels.data.map((channel) => (
    <ChannelDirectoryRow
      channel={channel}
      instanceAddress={instanceLabel}
      instanceId={activeInstance.id}
      key={channel.id}
      tokensSummary={tokensSummary}
      walletCount={walletCountOf(channel, principals.data ?? null)}
    />
  ));
}

/**
 * The Private Channels home. With `instanceId` it is that connection's page, and any other
 * connection, or none, is not found.
 */
export function ChannelDirectory({ instanceId }: { instanceId?: string }) {
  const t = useTranslations();
  const instance = usePrivateChannelInstance();

  if (instance.data === undefined) {
    return instance.error ? (
      <PrivateChannelsLoadError
        message={instance.error.message}
        onRetry={() => void instance.mutate()}
      />
    ) : (
      <PrivateChannelsOverviewSkeleton />
    );
  }
  if (instanceId !== undefined && instance.data?.id !== instanceId) {
    return <ProjectNotFound />;
  }
  const activeInstance = instance.data?.isActive ? instance.data : null;

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6" data-private-channels-directory>
      <section className="space-y-4" aria-labelledby="private-channels-list-title">
        <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
          <div className="space-y-1">
            <h2
              className="text-2xl font-medium tracking-tight text-primary"
              id="private-channels-list-title"
            >
              {t("DashboardPrivateChannels.directory.channelsTitle")}
            </h2>
            <p className="text-sm text-secondary">
              {t("DashboardPrivateChannels.directory.channelsDescription")}
            </p>
          </div>
          <ChannelHeaderAction activeInstanceId={activeInstance?.id ?? null} />
        </div>
        <DashboardWorkspaceCard className="grow-0">
          <div className="overflow-x-auto">
            <Table className="rounded-none border-0 [&_table]:min-w-[920px] [&_table]:table-fixed">
              <TableHeader>
                <TableRow>
                  <TableHead>{t("DashboardPrivateChannels.directory.channelColumn")}</TableHead>
                  <TableHead>{t("DashboardPrivateChannels.directory.instanceColumn")}</TableHead>
                  <TableHead>{t("DashboardPrivateChannels.directory.walletsColumn")}</TableHead>
                  <TableHead>{t("DashboardPrivateChannels.directory.tokensColumn")}</TableHead>
                  <TableHead>{t("DashboardPrivateChannels.directory.statusColumn")}</TableHead>
                  <TableHead align="right">
                    <span className="sr-only">
                      {t("DashboardPrivateChannels.directory.openColumn")}
                    </span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {activeInstance === null ? (
                  <TableRow>
                    <TableCell className="py-12 text-center text-secondary" colSpan={6}>
                      {t("DashboardPrivateChannels.directory.empty")}
                    </TableCell>
                  </TableRow>
                ) : (
                  <DirectoryRows activeInstance={activeInstance} />
                )}
              </TableBody>
            </Table>
          </div>
        </DashboardWorkspaceCard>
      </section>
    </div>
  );
}
