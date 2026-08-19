"use client";

import type {
  CustodyConnectionFailureCode,
  CustodyConnectionLifecycle,
  CustodyWalletSummary,
} from "@sdp/types";
import { CableIcon, PlusIcon } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { formatCustodyProviderName } from "@/app/dashboard/custody/provider-catalog";
import { WalletAddressCopyButton } from "@/app/dashboard/custody/wallet-address-copy-button";
import { formatWalletMeta } from "@/app/dashboard/custody/wallet-format-utils";
import { WalletProviderMark } from "@/app/dashboard/custody/wallet-provider-mark";
import { Badge, type BadgeVariant } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import {
  buildConnectionsSearchParams,
  CONNECTIONS_PAGE_SIZE,
  type ConnectionsFilters,
  type ConnectionsPageResult,
  type CustodyConnectionListItem,
} from "./connections.data";

const PROVIDER_COLUMN_CLASS = "hidden @2xl/connections-table:table-cell";
const CREATED_COLUMN_CLASS = "hidden @4xl/connections-table:table-cell";

const STATUS_BADGE_VARIANTS: Record<CustodyConnectionLifecycle, BadgeVariant> = {
  pending: "warning",
  checking: "info",
  active: "success",
  failed: "danger",
  deactivated: "outline",
};

type Translate = ReturnType<typeof useTranslations>;

function statusLabel(status: CustodyConnectionLifecycle, t: Translate): string {
  switch (status) {
    case "pending":
      return t("DashboardCustody.connectionStatusPending");
    case "checking":
      return t("DashboardCustody.connectionStatusChecking");
    case "active":
      return t("DashboardCustody.connectionStatusActive");
    case "failed":
      return t("DashboardCustody.connectionStatusFailed");
    case "deactivated":
      return t("DashboardCustody.connectionStatusDeactivated");
  }
}

/**
 * Short, secret-free explanation for a conclusively failed install. Codes come
 * from the installation service; anything unrecognized gets the generic line.
 */
function failureHint(failureCode: CustodyConnectionFailureCode | null, t: Translate): string {
  switch (failureCode) {
    case "invalid_credentials":
      return t("DashboardCustody.connectionFailureInvalidCredentials");
    case "provider_account_already_connected":
      return t("DashboardCustody.connectionFailureAccountAlreadyConnected");
    case "wallet_conflict":
      return t("DashboardCustody.connectionFailureWalletConflict");
    case "provider_response_unknown":
    case null:
      return t("DashboardCustody.connectionFailureGeneric");
    default: {
      const exhaustive: never = failureCode;
      return exhaustive;
    }
  }
}

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
}: {
  result: ConnectionsPageResult;
  filters: ConnectionsFilters;
  walletsByConnection: Record<string, CustodyWalletSummary[]>;
  walletsUnavailable: boolean;
  canManageCustody: boolean;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const router = useRouter();
  const pathname = usePathname();

  const { connections, pagination } = result;
  const pageCount = Math.max(1, Math.ceil(pagination.total / CONNECTIONS_PAGE_SIZE));

  const goToPage = (page: number) => {
    const query = buildConnectionsSearchParams(filters, { page }).toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  };

  const addConnectionAction = canManageCustody ? (
    <Button asChild size="sm">
      <Link href="/dashboard/wallets/setup?provider=privy">
        <PlusIcon className="size-4" />
        {t("DashboardCustody.addConnection")}
      </Link>
    </Button>
  ) : null;

  // Keyed on the slice, not the total: a deletion race can hand page 1 an
  // empty slice with a stale nonzero count, and a rowless table is never the
  // right render for that.
  if (connections.length === 0) {
    return (
      <ListEmptyState
        icon={<CableIcon className="size-5" />}
        message={t("DashboardCustody.connectionsEmpty")}
        description={t("DashboardCustody.connectionsEmptyDescription")}
        action={addConnectionAction}
      />
    );
  }

  return (
    <div className="@container/connections-table flex min-w-0 flex-1 flex-col">
      <div
        className="flex flex-col gap-3 border-b border-border-default p-4 sm:flex-row sm:items-center sm:justify-between"
        data-connections-toolbar
      >
        <p className="text-sm text-secondary">{t("DashboardCustody.connectionsDescription")}</p>
        {addConnectionAction}
      </div>
      <Table className="[&_table]:w-full [&_table]:min-w-0 [&_table]:table-fixed">
        <TableHeader>
          <TableRow>
            <TableHead className="w-[30%] @2xl/connections-table:w-[26%]">
              {t("DashboardCustody.connectionColumn")}
            </TableHead>
            <TableHead className={cn(PROVIDER_COLUMN_CLASS, "w-[16%]")}>
              {t("DashboardCustody.provider")}
            </TableHead>
            <TableHead className="w-[38%] @2xl/connections-table:w-[30%]">
              {t("DashboardCustody.wallets")}
            </TableHead>
            <TableHead className="w-[32%] @2xl/connections-table:w-[18%] @4xl/connections-table:w-[16%]">
              {t("DashboardCustody.status")}
            </TableHead>
            <TableHead className={cn(CREATED_COLUMN_CLASS, "w-[12%]")}>
              {t("DashboardCustody.created")}
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {connections.map((connection) => (
            <TableRow key={connection.id} data-connection-id={connection.id}>
              <TableCell className="font-medium">
                <span className="block truncate">{connection.providerCredential.label}</span>
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
                <Badge variant={STATUS_BADGE_VARIANTS[connection.status]}>
                  {statusLabel(connection.status, t)}
                </Badge>
                {connection.status === "failed" ? (
                  <span className="mt-1 block text-[11px] text-tertiary">
                    {failureHint(connection.lastCheck?.failureCode ?? null, t)}
                  </span>
                ) : null}
              </TableCell>
              <TableCell className={cn(CREATED_COLUMN_CLASS, "text-xs text-secondary")}>
                {formatDate(connection.createdAt, locale, t)}
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
    </div>
  );
}
