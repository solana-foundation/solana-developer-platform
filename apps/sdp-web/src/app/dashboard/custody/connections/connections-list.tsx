"use client";

import type { CustodyProvider, CustodyWalletSummary } from "@sdp/types";
import { CableIcon, MoreHorizontalIcon } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import { formatCustodyProviderName } from "@/app/dashboard/custody/provider-catalog";
import { WalletAddressCopyButton } from "@/app/dashboard/custody/wallet-address-copy-button";
import { formatWalletMeta } from "@/app/dashboard/custody/wallet-format-utils";
import { WalletProviderMark } from "@/app/dashboard/custody/wallet-provider-mark";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ListEmptyState } from "@/components/ui/list-empty-state";
import { PaginatedFooter } from "@/components/ui/paginated-footer";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useLocale, useTranslations } from "@/i18n/provider";
import { cn } from "@/lib/utils";
import { ConnectionStatusCell } from "./connection-status";
import {
  buildConnectionsSearchParams,
  CONNECTIONS_PAGE_SIZE,
  type ConnectionsFilters,
  type ConnectionsPageResult,
  type CustodyConnectionListItem,
} from "./connections.data";
import { MakeDefaultDialog } from "./make-default-dialog";

const PROVIDER_COLUMN_CLASS = "hidden @2xl/connections-table:table-cell";
const CREATED_COLUMN_CLASS = "hidden @4xl/connections-table:table-cell";

type Translate = ReturnType<typeof useTranslations>;

function formatDate(value: string | null, locale: string, t: Translate): string {
  if (!value) return t("DashboardCustody.never");
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString(locale, {
    month: "short",
    day: "2-digit",
    year: "numeric",
  });
}

function WalletCell({
  connection,
  wallets,
  walletsUnavailable,
}: {
  connection: CustodyConnectionListItem;
  wallets: CustodyWalletSummary[];
  walletsUnavailable: boolean;
}) {
  const t = useTranslations();

  if (wallets.length > 0) {
    const [first] = wallets;
    return (
      <div className="min-w-0">
        <span className="block truncate">{first.label?.trim() || first.walletId}</span>
        <span className="relative mt-1 flex items-center gap-1">
          <span className="block truncate font-mono text-[11px] font-normal text-tertiary">
            {formatWalletMeta(first.publicKey)}
          </span>
          <WalletAddressCopyButton address={first.publicKey} tooltip={first.publicKey} />
          {wallets.length > 1 ? (
            <span className="text-[11px] font-normal text-tertiary">
              {t("DashboardCustody.connectionMoreWallets", { count: wallets.length - 1 })}
            </span>
          ) : null}
        </span>
      </div>
    );
  }

  if (walletsUnavailable) {
    return (
      <span className="text-xs text-tertiary">
        {t("DashboardCustody.connectionWalletsUnavailable")}
      </span>
    );
  }

  if (connection.pendingWalletLabel) {
    return (
      <div className="min-w-0">
        <span className="block truncate">{connection.pendingWalletLabel}</span>
        <span className="mt-1 block text-[11px] font-normal text-tertiary">
          {t("DashboardCustody.connectionWalletPending")}
        </span>
      </div>
    );
  }

  return <span className="text-xs text-tertiary">{t("DashboardCustody.connectionNoWallets")}</span>;
}

export function ConnectionsList({
  result,
  filters,
  walletsByConnection,
  walletsUnavailable,
  canManageCustody,
  provider,
  projectName,
  emptyStateAction,
}: {
  result: ConnectionsPageResult;
  filters: ConnectionsFilters;
  walletsByConnection: Record<string, CustodyWalletSummary[]>;
  walletsUnavailable: boolean;
  canManageCustody: boolean;
  provider: CustodyProvider;
  projectName: string;
  emptyStateAction?: React.ReactNode;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const router = useRouter();
  const pathname = usePathname();
  const [defaultTarget, setDefaultTarget] = useState<CustodyConnectionListItem | null>(null);

  const { connections, pagination } = result;
  const pageCount = Math.max(1, Math.ceil(pagination.total / CONNECTIONS_PAGE_SIZE));
  const currentDefault = connections.find((connection) => connection.isDefault) ?? null;

  const goToPage = (page: number) => {
    const query = buildConnectionsSearchParams(filters, { page }).toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  };

  const connectionHref = (connectionId: string) =>
    `/dashboard/integrations/${provider}/connections/${encodeURIComponent(connectionId)}`;

  // Keyed on the slice, not the total: a deletion race can hand page 1 an
  // empty slice with a stale nonzero count, and a rowless table is never the
  // right render for that.
  if (connections.length === 0) {
    return (
      <ListEmptyState
        icon={<CableIcon className="size-5" />}
        message={t("DashboardCustody.connectionsEmptyInProject", { project: projectName })}
        description={t("DashboardCustody.connectionsEmptyDescription")}
        action={emptyStateAction}
      />
    );
  }

  return (
    <div className="@container/connections-table flex min-w-0 flex-1 flex-col">
      <Table className="[&_table]:w-full [&_table]:min-w-0 [&_table]:table-fixed">
        <TableHeader>
          <TableRow>
            <TableHead className="w-[30%] @2xl/connections-table:w-[24%]">
              {t("DashboardCustody.connectionColumn")}
            </TableHead>
            <TableHead className={cn(PROVIDER_COLUMN_CLASS, "w-[14%]")}>
              {t("DashboardCustody.provider")}
            </TableHead>
            <TableHead className="w-[34%] @2xl/connections-table:w-[28%]">
              {t("DashboardCustody.wallets")}
            </TableHead>
            <TableHead className="w-[28%] @2xl/connections-table:w-[18%] @4xl/connections-table:w-[16%]">
              {t("DashboardCustody.status")}
            </TableHead>
            <TableHead className={cn(CREATED_COLUMN_CLASS, "w-[12%]")}>
              {t("DashboardCustody.created")}
            </TableHead>
            <TableHead className="w-[8%]">
              <span className="sr-only">{t("DashboardCustody.actions")}</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {connections.map((connection) => (
            <TableRow key={connection.id} data-connection-id={connection.id}>
              <TableCell className="font-medium">
                <span className="flex min-w-0 items-center gap-2">
                  <Link
                    href={connectionHref(connection.id)}
                    className="truncate hover:underline"
                    data-connection-link
                  >
                    {connection.label}
                  </Link>
                  {connection.isDefault ? (
                    <Badge variant="outline">{t("DashboardCustody.defaultBadge")}</Badge>
                  ) : null}
                </span>
                <span className="mt-1 block truncate font-mono text-[11px] font-normal text-tertiary">
                  {formatWalletMeta(connection.id, 10, 6)}
                </span>
              </TableCell>
              <TableCell className={PROVIDER_COLUMN_CLASS}>
                <span className="flex items-center gap-2">
                  <WalletProviderMark provider={connection.provider} size="xs" />
                  <span className="truncate text-xs">
                    {formatCustodyProviderName(connection.provider)}
                  </span>
                </span>
              </TableCell>
              <TableCell className="text-xs">
                <WalletCell
                  connection={connection}
                  wallets={walletsByConnection[connection.id] ?? []}
                  walletsUnavailable={walletsUnavailable}
                />
              </TableCell>
              <TableCell className="text-xs">
                <ConnectionStatusCell
                  status={connection.status}
                  failureCode={connection.lastCheck?.failureCode ?? null}
                  isRuntimeExecutionAllowed={connection.isRuntimeExecutionAllowed}
                />
              </TableCell>
              <TableCell className={cn(CREATED_COLUMN_CLASS, "text-xs text-secondary")}>
                {formatDate(connection.createdAt, locale, t)}
              </TableCell>
              <TableCell className="text-right">
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={t("DashboardCustody.connectionRowActions", {
                        label: connection.label,
                      })}
                    >
                      <MoreHorizontalIcon aria-hidden className="size-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem asChild>
                      <Link href={connectionHref(connection.id)}>
                        {t("DashboardCustody.openConnection")}
                      </Link>
                    </DropdownMenuItem>
                    {/* Only an active connection can take signing, and making
                        the current default the default again is a no-op. */}
                    {canManageCustody &&
                    connection.status === "active" &&
                    !connection.isDefault ? (
                      <DropdownMenuItem onSelect={() => setDefaultTarget(connection)}>
                        {t("DashboardCustody.makeDefaultAction")}
                      </DropdownMenuItem>
                    ) : null}
                  </DropdownMenuContent>
                </DropdownMenu>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {pageCount > 1 ? (
        <PaginatedFooter
          className="mt-auto"
          page={filters.page}
          pageCount={pageCount}
          onPageChange={goToPage}
        />
      ) : null}

      {defaultTarget ? (
        <MakeDefaultDialog
          isOpen
          onClose={() => setDefaultTarget(null)}
          connectionId={defaultTarget.id}
          label={defaultTarget.label}
          provider={provider}
          projectName={projectName}
          currentDefaultLabel={currentDefault?.label ?? null}
        />
      ) : null}
    </div>
  );
}
