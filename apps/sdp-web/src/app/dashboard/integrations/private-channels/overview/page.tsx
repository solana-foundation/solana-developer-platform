import Link from "next/link";
import { DashboardWorkspaceCard } from "@/components/dashboard-workspace-panel";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { getTranslations } from "@/i18n/server";
import { createSdpApiClient } from "@/lib/sdp-api";
import { requirePrivateChannelsAccess } from "../private-channels-access";
import { PrivateChannelsLoadError } from "../private-channels-load-error";
import {
  loadChannels,
  loadInstance,
  loadPrincipals,
  loadTokenEligibility,
} from "../private-channels-page.data";
import { PRIVATE_CHANNELS_SETUP_PATH } from "../private-channels-routes";
import { ChannelDirectoryRow } from "./channel-directory-row";
import { CreateChannelButton } from "./create-channel-button";

function instanceAddress(address: string): string {
  return address.length > 13 ? `${address.slice(0, 6)}…${address.slice(-6)}` : address;
}

export default async function PrivateChannelsOverviewPage() {
  await requirePrivateChannelsAccess();

  const [t, client] = await Promise.all([getTranslations(), createSdpApiClient()]);
  const instance = await loadInstance(client);

  if (!instance.ok) {
    return <PrivateChannelsLoadError message={instance.error} />;
  }

  const activeInstance = instance.data?.isActive ? instance.data : null;
  const connectedData = activeInstance
    ? await Promise.all([
        loadChannels(client),
        loadPrincipals(client),
        loadTokenEligibility(client),
      ])
    : null;
  const channels = connectedData?.[0] ?? null;
  const principals = connectedData?.[1] ?? null;
  const tokenEligibility = connectedData?.[2] ?? null;

  if (channels && !channels.ok) {
    return <PrivateChannelsLoadError message={channels.error} />;
  }

  const enabledSymbols = tokenEligibility?.ok
    ? tokenEligibility.data.filter((token) => token.enabled).map((token) => token.symbol)
    : [];
  const tokensSummary =
    enabledSymbols.length > 0
      ? enabledSymbols.join(", ")
      : tokenEligibility?.ok
        ? t("DashboardPrivateChannels.directory.noTokens")
        : t("DashboardPrivateChannels.directory.tokensUnavailable");
  const channelRows = channels?.data ?? [];
  const principalRows = principals?.data.principals ?? [];

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
          {activeInstance ? (
            <CreateChannelButton instanceId={activeInstance.id} />
          ) : (
            <Button asChild>
              <Link href={PRIVATE_CHANNELS_SETUP_PATH}>
                {t("DashboardPrivateChannels.directory.setupChannel")}
              </Link>
            </Button>
          )}
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
                {channelRows.length === 0 ? (
                  <TableRow>
                    <TableCell className="py-12 text-center text-secondary" colSpan={6}>
                      {t("DashboardPrivateChannels.directory.empty")}
                    </TableCell>
                  </TableRow>
                ) : activeInstance ? (
                  channelRows.map((channel) => {
                    const walletCount = principalRows
                      .filter(
                        (principal) =>
                          principal.status === "active" &&
                          principal.channels.some((membership) => membership.id === channel.id)
                      )
                      .reduce((count, principal) => count + principal.verifiedWalletCount, 0);
                    return (
                      <ChannelDirectoryRow
                        channel={channel}
                        instanceAddress={instanceAddress(activeInstance.escrowInstanceAddr)}
                        instanceId={activeInstance.id}
                        key={channel.id}
                        tokensSummary={tokensSummary}
                        walletCount={walletCount}
                      />
                    );
                  })
                ) : null}
              </TableBody>
            </Table>
          </div>
        </DashboardWorkspaceCard>
      </section>
    </div>
  );
}
