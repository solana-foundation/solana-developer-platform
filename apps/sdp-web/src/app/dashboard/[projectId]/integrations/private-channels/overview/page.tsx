import { Button } from "@sdp/ui/button";
import { TableCell } from "@sdp/ui/table";
import { Table, TableBody, TableHead, TableHeader, TableRow } from "@solana/design-system/table";
import Link from "next/link";
import { requirePrivateChannelsAccess } from "@/app/dashboard/[projectId]/integrations/private-channels/private-channels-access";
import { PrivateChannelsLoadError } from "@/app/dashboard/[projectId]/integrations/private-channels/private-channels-load-error";
import {
  loadChannels,
  loadInstance,
  loadPrincipals,
  loadTokenEligibility,
} from "@/app/dashboard/[projectId]/integrations/private-channels/private-channels-page.data";
import { PRIVATE_CHANNELS_SETUP_PATH } from "@/app/dashboard/[projectId]/integrations/private-channels/private-channels-routes";
import {
  enabledTokenSymbols,
  shortenAddress,
} from "@/app/dashboard/[projectId]/integrations/private-channels/private-channels-view-data";
import { DashboardWorkspaceCard } from "@/components/dashboard-workspace-panel";
import { getTranslations } from "@/i18n/server";
import { resolveDashboardAccess } from "@/lib/dashboard-access";
import { createSdpApiClient, requestMemberRole, requestProjectHref } from "@/lib/sdp-api";
import { ChannelDirectoryRow } from "./channel-directory-row";
import { CreateChannelButton } from "./create-channel-button";

type Translate = Awaited<ReturnType<typeof getTranslations>>;
type SdpClient = Awaited<ReturnType<typeof createSdpApiClient>>;

async function loadDirectory(client: SdpClient, t: Translate) {
  const instance = await loadInstance(client);
  if (!instance.ok) return { ok: false, error: instance.error } as const;

  const activeInstance = instance.data?.isActive ? instance.data : null;
  if (!activeInstance) {
    return { ok: true, data: { activeInstance: null, rows: [] } } as const;
  }

  const [channels, principals, tokenEligibility] = await Promise.all([
    loadChannels(client),
    loadPrincipals(client),
    loadTokenEligibility(client),
  ]);
  if (!channels.ok) return { ok: false, error: channels.error } as const;

  const symbols = tokenEligibility.ok ? enabledTokenSymbols(tokenEligibility.data) : [];
  const tokensSummary =
    symbols.length > 0
      ? symbols.join(", ")
      : tokenEligibility.ok
        ? t("DashboardPrivateChannels.directory.noTokens")
        : t("DashboardPrivateChannels.directory.tokensUnavailable");
  const principalRows = principals.ok ? principals.data.principals : [];
  const rows = channels.data.map((channel) => {
    let walletCount = 0;
    for (const principal of principalRows) {
      const belongsToChannel = principal.channels.some(
        (membership) => membership.id === channel.id
      );
      if (principal.status === "active" && belongsToChannel) {
        walletCount += principal.verifiedWalletCount;
      }
    }
    return {
      channel,
      instanceId: activeInstance.id,
      instanceLabel: shortenAddress(activeInstance.escrowInstanceAddr, 6),
      tokensSummary,
      walletCount,
    };
  });

  return {
    ok: true,
    data: {
      activeInstance,
      rows,
    },
  } as const;
}

/**
 * The directory header's action: none for a read-only member, a new channel once an instance is
 * connected, else the way to connect one.
 */
function ChannelHeaderAction({
  canWrite,
  activeInstanceId,
  setupHref,
  setupLabel,
}: {
  canWrite: boolean;
  activeInstanceId: string | null;
  setupHref: string;
  setupLabel: string;
}) {
  if (!canWrite) return null;
  if (activeInstanceId !== null) return <CreateChannelButton instanceId={activeInstanceId} />;
  return (
    <Button asChild>
      <Link href={setupHref}>{setupLabel}</Link>
    </Button>
  );
}

export default async function PrivateChannelsOverviewPage() {
  await requirePrivateChannelsAccess();

  const [t, client, memberRole] = await Promise.all([
    getTranslations(),
    createSdpApiClient(),
    requestMemberRole(),
  ]);
  const { canWrite } = resolveDashboardAccess(memberRole).capabilities;
  const result = await loadDirectory(client, t);
  if (!result.ok) return <PrivateChannelsLoadError message={result.error} />;
  const { activeInstance, rows } = result.data;

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
          <ChannelHeaderAction
            canWrite={canWrite}
            activeInstanceId={activeInstance?.id ?? null}
            setupHref={await requestProjectHref(PRIVATE_CHANNELS_SETUP_PATH)}
            setupLabel={t("DashboardPrivateChannels.directory.setupChannel")}
          />
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
                {rows.length === 0 ? (
                  <TableRow>
                    <TableCell className="py-12 text-center text-secondary" colSpan={6}>
                      {t("DashboardPrivateChannels.directory.empty")}
                    </TableCell>
                  </TableRow>
                ) : activeInstance ? (
                  rows.map(({ channel, instanceId, instanceLabel, tokensSummary, walletCount }) => (
                    <ChannelDirectoryRow
                      channel={channel}
                      instanceAddress={instanceLabel}
                      instanceId={instanceId}
                      key={channel.id}
                      tokensSummary={tokensSummary}
                      walletCount={walletCount}
                    />
                  ))
                ) : null}
              </TableBody>
            </Table>
          </div>
        </DashboardWorkspaceCard>
      </section>
    </div>
  );
}
