"use client";

import type { CustodyProvider, CustodyWalletSummary } from "@sdp/types/custody";
import { ListEmptyState } from "@sdp/ui/list-empty-state";
import { StatusText, type StatusTone } from "@sdp/ui/status-text";
import { TableCell } from "@sdp/ui/table";
import { Table, TableBody, TableHead, TableHeader, TableRow } from "@solana/design-system/table";
import { ChevronRightIcon } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import type { MouseEvent, ReactNode } from "react";
import { PaginatedFooter } from "@/components/ui/paginated-footer";
import { useLocale, useTranslations } from "@/i18n/provider";
import { useTimeZone } from "@/i18n/time-zone";
import { useProjectHref } from "@/lib/use-dashboard-project";
import { failureHint, statusLabel } from "./connection-status-presentation";
import {
  buildConnectionsSearchParams,
  CONNECTIONS_PAGE_SIZE,
  type ConnectionsFilters,
  type ConnectionsPageResult,
  type CustodyConnectionListItem,
} from "./connections.data";

type Translate = ReturnType<typeof useTranslations>;

const LIFECYCLE_TONES = {
  pending: "attention",
  checking: "progress",
  active: "positive",
  failed: "critical",
  deactivated: "neutral",
} as const satisfies Record<CustodyConnectionListItem["status"], StatusTone>;

function formatCreated(value: string, locale: string, timeZone: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString(locale, {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone,
  });
}

function walletsPart(
  connection: CustodyConnectionListItem,
  wallets: CustodyWalletSummary[],
  walletsUnavailable: boolean,
  t: Translate
): string {
  if (wallets.length === 1) return t("DashboardCustody.connectionWalletCountOne");
  if (wallets.length > 1) {
    return t("DashboardCustody.connectionWalletCount", { count: wallets.length });
  }
  if (walletsUnavailable) return t("DashboardCustody.connectionWalletsUnavailable");
  if (connection.pendingWalletLabel) return t("DashboardCustody.connectionWalletPending");
  return t("DashboardCustody.connectionNoWallets");
}

/**
 * The line under a connection's name. An active connection reads as what it holds, and says so
 * when it cannot sign; any other state leads with the state, a dot in its tone before it.
 */
function ConnectionSummary({
  connection,
  wallets,
  walletsUnavailable,
}: {
  connection: CustodyConnectionListItem;
  wallets: CustodyWalletSummary[];
  walletsUnavailable: boolean;
}) {
  const t = useTranslations();
  if (connection.status === "active") {
    return (
      <span className="block truncate text-body text-secondary">
        {walletsPart(connection, wallets, walletsUnavailable, t)}
        {connection.isRuntimeExecutionAllowed ? null : (
          <>
            {" · "}
            <StatusText tone="attention" className="whitespace-nowrap">
              <span data-signing-state="paused">
                {t("DashboardCustody.connectionSigningPaused")}
              </span>
            </StatusText>
          </>
        )}
      </span>
    );
  }
  const state = statusLabel(connection.status, t);
  const text =
    connection.status === "failed"
      ? t("DashboardCustody.connectionStateWithReason", {
          state,
          reason: failureHint(connection.lastCheck?.failureCode ?? null, t),
        })
      : state;
  return (
    <StatusText
      tone={LIFECYCLE_TONES[connection.status]}
      className="flex min-w-0 items-center gap-2 text-body"
    >
      <span
        aria-hidden
        className={
          connection.status === "deactivated"
            ? "size-1.5 shrink-0 rounded-full border border-current"
            : "size-1.5 shrink-0 rounded-full bg-current"
        }
      />
      <span className="truncate">{text}</span>
    </StatusText>
  );
}

export function ConnectionsList({
  result,
  filters,
  walletsByConnection,
  walletsUnavailable,
  provider,
  projectName,
  emptyStateAction,
}: {
  result: ConnectionsPageResult;
  filters: ConnectionsFilters;
  walletsByConnection: Record<string, CustodyWalletSummary[]>;
  walletsUnavailable: boolean;
  provider: CustodyProvider;
  projectName: string;
  emptyStateAction?: ReactNode;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const timeZone = useTimeZone();
  const router = useRouter();
  const pathname = usePathname();
  const href = useProjectHref();

  const { connections, pagination } = result;
  const pageCount = Math.max(1, Math.ceil(pagination.total / CONNECTIONS_PAGE_SIZE));

  const goToPage = (page: number) => {
    const query = buildConnectionsSearchParams(filters, { page }).toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  };

  const connectionHref = (connectionId: string) =>
    href(`/dashboard/integrations/${provider}/connections/${encodeURIComponent(connectionId)}`);

  // The name is the row's link for keyboards and screen readers; a press anywhere else on the
  // row goes to the same place.
  const openRow = (event: MouseEvent<HTMLTableRowElement>, connectionId: string) => {
    if (event.target instanceof Element && event.target.closest("a")) return;
    router.push(connectionHref(connectionId));
  };

  // Keyed on the slice, not the total: a deletion race can hand page 1 an
  // empty slice with a stale nonzero count, and a rowless table is never the
  // right render for that.
  if (connections.length === 0) {
    return (
      <ListEmptyState
        message={t("DashboardCustody.connectionsEmptyInProject", { project: projectName })}
        description={t("DashboardCustody.connectionsEmptyDescription")}
        action={emptyStateAction}
      />
    );
  }

  return (
    <div className="flex min-w-0 flex-col">
      <Table className="-mx-3 min-w-0 rounded-none border-0 [&_table]:table-fixed">
        <TableHeader>
          <TableRow>
            <TableHead>{t("DashboardCustody.connectionColumn")}</TableHead>
            <TableHead className="hidden w-32 text-right sm:table-cell">
              {t("DashboardCustody.created")}
            </TableHead>
            <TableHead className="w-10">
              <span className="sr-only">{t("DashboardCustody.openConnection")}</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {connections.map((connection) => (
            <TableRow
              key={connection.id}
              data-connection-id={connection.id}
              className="cursor-pointer"
              onClick={(event: MouseEvent<HTMLTableRowElement>) => openRow(event, connection.id)}
            >
              <TableCell className="min-w-0 py-3 whitespace-normal">
                <span className="flex min-w-0 items-baseline gap-2">
                  <Link
                    href={connectionHref(connection.id)}
                    className="truncate text-field font-medium text-primary hover:underline"
                    data-connection-link
                  >
                    {connection.label}
                  </Link>
                  <span className="shrink-0 font-mono text-meta text-tertiary">
                    {`····${connection.id.slice(-4)}`}
                  </span>
                </span>
                <span className="mt-1 block min-w-0">
                  <ConnectionSummary
                    connection={connection}
                    wallets={walletsByConnection[connection.id] ?? []}
                    walletsUnavailable={walletsUnavailable}
                  />
                </span>
              </TableCell>
              <TableCell className="hidden align-top py-3 text-right text-secondary tabular-nums sm:table-cell">
                {formatCreated(connection.createdAt, locale, timeZone)}
              </TableCell>
              <TableCell className="align-top py-3 text-right text-tertiary">
                <ChevronRightIcon aria-hidden className="ml-auto size-4" />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {pageCount > 1 ? (
        <PaginatedFooter page={filters.page} pageCount={pageCount} onPageChange={goToPage} />
      ) : null}
    </div>
  );
}
