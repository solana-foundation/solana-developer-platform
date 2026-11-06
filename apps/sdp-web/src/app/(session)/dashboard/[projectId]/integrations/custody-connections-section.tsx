"use client";

import type { CustodyProvider, CustodyWalletSummary } from "@sdp/types/custody";
import { Button } from "@sdp/ui/button";
import { Callout } from "@sdp/ui/callout";
import { PlusIcon } from "lucide-react";
import Link from "next/link";
import type {
  ConnectionsFilters,
  ConnectionsPageResult,
  ConnectionsProjectSummary,
} from "@/app/(session)/dashboard/[projectId]/wallets/connections/connections.data";
import { ConnectionsList } from "@/app/(session)/dashboard/[projectId]/wallets/connections/connections-list";
import { useSelectedProjectName } from "@/app/(session)/dashboard/[projectId]/wallets/connections/use-selected-project-name";
import { formatCustodyProviderName } from "@/app/(session)/dashboard/[projectId]/wallets/provider-catalog";
import { RecordBlock } from "@/components/refresh-record";
import { useTranslations } from "@/i18n/provider";
import { useProjectHref } from "@/lib/use-dashboard-project";

/**
 * "2 of 4 connections can sign in Acme Payments", under the provider's state.
 *
 * A client component only because the project's display name lives in the
 * workspace the shell resolved; the counts come from the server read. A summary
 * that could not see every connection cannot say how many sign, so it gives the
 * count alone.
 */
export function CustodyConnectionsSigningLine({
  total,
  summary,
}: {
  total: number;
  summary: ConnectionsProjectSummary;
}) {
  const t = useTranslations();
  const project = useSelectedProjectName();
  if (total === 0) {
    return <>{t("DashboardCustody.connectionsEmptyInProject", { project })}</>;
  }
  if (!summary.complete) {
    return <>{t("DashboardCustody.connectionCountInProject", { count: total, project })}</>;
  }
  return (
    <>
      {t("DashboardCustody.connectionsSigningInProject", {
        signing: summary.signingCount,
        count: total,
        project,
      })}
    </>
  );
}

/**
 * The project's custody connections, on the provider page that owns them.
 *
 * Two banners can appear above the list, and they answer two different
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
  const href = useProjectHref();
  const projectName = useSelectedProjectName();

  // A summary that could not see every connection does not support the banner:
  // it is a statement about all of them, and silence beats a false alarm.
  const signingPaused = summary.complete && summary.signingPaused;

  const addConnectionButton = canManageCustody ? (
    <Button asChild size="sm" iconLeft={<PlusIcon className="size-4" />}>
      <Link href={href(`/dashboard/integrations/${provider}/connections/new`)}>
        {t("DashboardCustody.addConnection")}
      </Link>
    </Button>
  ) : null;

  return (
    <RecordBlock
      title={t("DashboardCustody.connectionsTitle")}
      hint={t("DashboardCustody.connectionsHint", {
        provider: formatCustodyProviderName(provider),
      })}
      aside={result.connections.length > 0 ? addConnectionButton : null}
    >
      {!canManageCustody ? (
        <Callout variant="neutral">{t("DashboardCustody.readOnlyViewer")}</Callout>
      ) : null}

      {signingPaused ? (
        <Callout variant="warning" title={t("DashboardCustody.signingPausedTitle")}>
          {t("DashboardCustody.signingPausedBody")}
        </Callout>
      ) : null}

      <ConnectionsList
        result={result}
        filters={filters}
        walletsByConnection={walletsByConnection}
        walletsUnavailable={walletsUnavailable}
        provider={provider}
        projectName={projectName}
        emptyStateAction={addConnectionButton}
      />
    </RecordBlock>
  );
}
