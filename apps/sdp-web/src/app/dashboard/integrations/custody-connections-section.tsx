"use client";

import type { CustodyProvider, CustodyWalletSummary } from "@sdp/types";
import { PlusIcon } from "lucide-react";
import { useState } from "react";
import { AddConnectionModal } from "@/app/dashboard/custody/connections/add-connection-modal";
import type {
  ConnectionsFilters,
  ConnectionsPageResult,
  ConnectionsProjectSummary,
} from "@/app/dashboard/custody/connections/connections.data";
import { ConnectionsList } from "@/app/dashboard/custody/connections/connections-list";
import { useSelectedProjectName } from "@/app/dashboard/custody/connections/use-selected-project-name";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { useTranslations } from "@/i18n/provider";

/**
 * "4 connections in Acme Payments", for the provider header.
 *
 * A client component only because the project's display name lives in the
 * workspace the shell resolved; the count itself comes from the server read.
 */
export function CustodyConnectionCount({ count }: { count: number }) {
  const t = useTranslations();
  const projectName = useSelectedProjectName();
  return (
    <>
      {projectName
        ? t("DashboardCustody.connectionCountInProject", { count, project: projectName })
        : t("DashboardCustody.connectionCount", { count })}
    </>
  );
}

/**
 * The project's custody connections, on the provider page that owns them.
 *
 * Three banners can appear above the table, and they answer three different
 * questions:
 *
 * - No default: requests that do not name a wallet have nowhere to go, which is
 *   a live failure rather than a tidiness problem, so it is stated as one.
 * - Signing paused: the organization is not permitted to sign through its own
 *   credentials right now. The connections are untouched and still maintainable,
 *   and saying so is the whole point — an unexplained loss of signing reads as
 *   deletion.
 * - Read-only viewer: naming the role and where to ask for it is more use than
 *   hiding the controls silently.
 *
 * The first two are claims about the project, so they read `summary` rather
 * than the rows on screen: inferred from the visible page, a default sitting on
 * page 2 raised "No default connection" over a project that had one, and one
 * paused connection among twenty paused the whole table's banner.
 */
export function CustodyConnectionsSection({
  result,
  filters,
  summary,
  walletsByConnection,
  walletsUnavailable,
  canManageCustody,
  provider,
}: {
  result: ConnectionsPageResult;
  filters: ConnectionsFilters;
  summary: ConnectionsProjectSummary;
  walletsByConnection: Record<string, CustodyWalletSummary[]>;
  walletsUnavailable: boolean;
  canManageCustody: boolean;
  provider: CustodyProvider;
}) {
  const t = useTranslations();
  const projectName = useSelectedProjectName();
  const [addOpen, setAddOpen] = useState(false);

  // A summary that could not see every connection supports neither banner:
  // both are statements about all of them, and silence beats a false alarm.
  const signingPaused = summary.complete && summary.signingPaused;
  const noDefault = summary.complete && summary.activeCount > 0 && !summary.defaultConnection;

  const addConnectionButton = canManageCustody ? (
    <Button size="sm" onClick={() => setAddOpen(true)} iconLeft={<PlusIcon className="size-4" />}>
      {t("DashboardCustody.addConnection")}
    </Button>
  ) : null;

  return (
    <section className="rounded-2xl border border-border-default bg-surface-raised p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-base font-medium text-primary">
          {t("DashboardCustody.connectionsTitle")}
        </h2>
        {addConnectionButton}
      </div>

      <div className="mt-4 space-y-3">
        {!canManageCustody ? (
          <Callout variant="neutral">{t("DashboardCustody.readOnlyViewer")}</Callout>
        ) : null}

        {signingPaused ? (
          <Callout variant="warning" title={t("DashboardCustody.signingPausedTitle")}>
            {t("DashboardCustody.signingPausedBody")}
          </Callout>
        ) : null}

        {noDefault ? (
          <Callout variant="warning" title={t("DashboardCustody.noDefaultTitle")}>
            {t("DashboardCustody.noDefaultBody")}
          </Callout>
        ) : null}

        <div className="overflow-hidden rounded-xl border border-border-default">
          <ConnectionsList
            result={result}
            filters={filters}
            summary={summary}
            walletsByConnection={walletsByConnection}
            walletsUnavailable={walletsUnavailable}
            canManageCustody={canManageCustody}
            provider={provider}
            projectName={projectName}
            emptyStateAction={addConnectionButton}
          />
        </div>
      </div>

      <AddConnectionModal isOpen={addOpen} onClose={() => setAddOpen(false)} provider={provider} />
    </section>
  );
}
