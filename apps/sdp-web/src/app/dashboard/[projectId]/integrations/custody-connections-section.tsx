"use client";

import type { CustodyProvider, CustodyWalletSummary } from "@sdp/types";
import { PlusIcon } from "lucide-react";
import { useState } from "react";
import { AddConnectionModal } from "@/app/dashboard/[projectId]/custody/connections/add-connection-modal";
import type {
  ConnectionsFilters,
  ConnectionsPageResult,
  ConnectionsProjectSummary,
} from "@/app/dashboard/[projectId]/custody/connections/connections.data";
import { ConnectionsList } from "@/app/dashboard/[projectId]/custody/connections/connections-list";
import { useSelectedProjectName } from "@/app/dashboard/[projectId]/custody/connections/use-selected-project-name";
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
 * Two banners can appear above the table, and they answer two different
 * questions:
 *
 * - Signing paused: the organization is not permitted to sign through its own
 *   credentials right now. The connections are untouched and still maintainable,
 *   and saying so is the whole point — an unexplained loss of signing reads as
 *   deletion.
 * - Read-only viewer: naming the role and where to ask for it is more use than
 *   hiding the controls silently.
 *
 * Signing paused is a claim about the project, so it reads `summary` rather
 * than the rows on screen: inferred from the visible page, one paused
 * connection among twenty paused the whole table's banner.
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

  // A summary that could not see every connection does not support the banner:
  // it is a statement about all of them, and silence beats a false alarm.
  const signingPaused = summary.complete && summary.signingPaused;

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

        <div className="overflow-hidden rounded-xl border border-border-default">
          <ConnectionsList
            result={result}
            filters={filters}
            walletsByConnection={walletsByConnection}
            walletsUnavailable={walletsUnavailable}
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
