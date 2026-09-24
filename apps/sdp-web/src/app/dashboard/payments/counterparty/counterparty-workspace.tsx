"use client";

import type { Counterparty, CounterpartyAccountSummary } from "@sdp/types";
import { MoreHorizontalIcon, PlusIcon, Trash2Icon, UserIcon, UsersIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { WalletMetadataCopyButton } from "@/app/dashboard/custody/wallet-address-copy-button";
import { DashboardWorkspaceOverviewPanel } from "@/components/dashboard-workspace-panel";
import { ArrowPagination } from "@/components/ui/arrow-pagination";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { FilterMenu, FilterMenuOptions } from "@/components/ui/filter-menu";
import { ListToolbar, RowsPerPageSelect } from "@/components/ui/list-toolbar";
import { SearchInput } from "@/components/ui/search-input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useLocale, useTranslations } from "@/i18n/provider";
import { dashboardFetch } from "@/lib/dashboard-fetch";
import { shortenAddress } from "../payments-overview.utils";
import { formatDate } from "../payments-presentation";
import { DeleteCounterpartyDialog } from "./delete-counterparty-dialog";

type AddressFilter = "with" | "without";

function counterpartyHref(counterpartyId: string): string {
  return `/dashboard/payments/counterparty/${counterpartyId}`;
}

interface CounterpartyWorkspaceProps {
  counterparties: Counterparty[];
  /** The directory's full size; more than `counterparties.length` when the load was capped. */
  total: number;
  accounts: CounterpartyAccountSummary[];
}

/**
 * The Contact list. The directory API has no search or filters, so the page loads the
 * directory (up to a cap) with every saved Solana address once, and searches, filters and pages
 * it here. When the cap cut the directory short, the list says so.
 */
export function CounterpartyWorkspace({
  counterparties: initialCounterparties,
  total,
  accounts,
}: CounterpartyWorkspaceProps) {
  const t = useTranslations();
  const locale = useLocale();
  const router = useRouter();
  const [counterparties, setCounterparties] = useState(initialCounterparties);
  const [query, setQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState<Counterparty["entityType"] | undefined>();
  const [addressFilter, setAddressFilter] = useState<AddressFilter | undefined>();
  const [pageSize, setPageSize] = useState(25);
  const [page, setPage] = useState(1);
  const [pendingDelete, setPendingDelete] = useState<Counterparty | null>(null);

  const addressesByCounterparty = useMemo(() => {
    const byId = new Map<string, string[]>();
    for (const account of accounts) {
      const list = byId.get(account.counterpartyId) ?? [];
      list.push(account.address);
      byId.set(account.counterpartyId, list);
    }
    return byId;
  }, [accounts]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return counterparties.filter((counterparty) => {
      const addresses = addressesByCounterparty.get(counterparty.id) ?? [];
      if (typeFilter !== undefined && counterparty.entityType !== typeFilter) return false;
      if (addressFilter === "with" && addresses.length === 0) return false;
      if (addressFilter === "without" && addresses.length > 0) return false;
      if (!needle) return true;
      return [
        counterparty.displayName,
        counterparty.externalId ?? "",
        counterparty.id,
        ...addresses,
      ]
        .join(" ")
        .toLowerCase()
        .includes(needle);
    });
  }, [counterparties, addressesByCounterparty, query, typeFilter, addressFilter]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const currentPage = Math.min(page, pageCount);
  const rows = filtered.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  const typeLabel = (type: Counterparty["entityType"]) =>
    type === "individual"
      ? t("DashboardPayments.counterparty.individual")
      : t("DashboardPayments.counterparty.business");
  const addressFilterLabel = (value: AddressFilter) =>
    value === "with"
      ? t("DashboardPayments.counterparty.hasAddress")
      : t("DashboardPayments.counterparty.noAddress");
  const resetPage =
    <T,>(set: (value: T) => void) =>
    (value: T) => {
      set(value);
      setPage(1);
    };

  async function confirmDelete() {
    if (!pendingDelete) return;
    const target = pendingDelete;
    setCounterparties((current) => current.filter((row) => row.id !== target.id));
    setPendingDelete(null);
    const result = await dashboardFetch(
      `/api/dashboard/counterparty/${encodeURIComponent(target.id)}`,
      { method: "DELETE" }
    );
    if (!result.ok) {
      toast.error(result.error, { position: "bottom-right" });
      router.refresh();
      return;
    }
    toast.success(t("DashboardPayments.counterparty.deleted", { name: target.displayName }), {
      position: "bottom-right",
    });
    router.refresh();
  }

  if (initialCounterparties.length === 0) {
    return (
      <DashboardWorkspaceOverviewPanel className="flex flex-col items-center justify-center gap-4 py-20 text-center">
        <UsersIcon className="size-8 text-tertiary" strokeWidth={1.5} aria-hidden="true" />
        <div className="space-y-1">
          <p className="text-body font-medium text-primary">
            {t("DashboardPayments.counterparty.noContacts")}
          </p>
          <p className="text-body text-secondary">
            {t("DashboardPayments.counterparty.noContactsDescription")}
          </p>
        </div>
        <Button asChild size="sm">
          <Link href="/dashboard/payments/counterparty/create">
            <PlusIcon className="size-4" aria-hidden="true" />
            {t("DashboardPayments.counterparty.add")}
          </Link>
        </Button>
      </DashboardWorkspaceOverviewPanel>
    );
  }

  return (
    <DashboardWorkspaceOverviewPanel className="flex flex-col gap-5">
      <ListToolbar
        filters={
          <FilterMenu
            label={t("Shared.SharedComponents.filter")}
            searchPlaceholder={t("Shared.SharedComponents.filterBy")}
            sections={[
              {
                id: "type",
                label: t("DashboardPayments.counterparty.type"),
                value: typeFilter === undefined ? undefined : typeLabel(typeFilter),
                content: (
                  <FilterMenuOptions
                    value={typeFilter}
                    anyLabel={t("Shared.SharedComponents.any")}
                    options={(["individual", "business"] as const).map((type) => ({
                      value: type,
                      label: typeLabel(type),
                    }))}
                    onChange={resetPage((value) =>
                      setTypeFilter(
                        value === "individual" || value === "business" ? value : undefined
                      )
                    )}
                  />
                ),
              },
              {
                id: "address",
                label: t("DashboardPayments.counterparty.address"),
                value: addressFilter === undefined ? undefined : addressFilterLabel(addressFilter),
                content: (
                  <FilterMenuOptions
                    value={addressFilter}
                    anyLabel={t("Shared.SharedComponents.any")}
                    options={(["with", "without"] as const).map((value) => ({
                      value,
                      label: addressFilterLabel(value),
                    }))}
                    onChange={resetPage((value) =>
                      setAddressFilter(value === "with" || value === "without" ? value : undefined)
                    )}
                  />
                ),
              },
            ]}
          />
        }
      >
        <RowsPerPageSelect value={pageSize} onChange={resetPage(setPageSize)} />
        <SearchInput
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setPage(1);
          }}
          clear={{
            label: t("DashboardPayments.counterparty.clearSearch"),
            onClear: () => setQuery(""),
          }}
          placeholder={t("DashboardPayments.counterparty.searchPlaceholder")}
          className="w-full sm:w-80"
        />
      </ListToolbar>
      {total > initialCounterparties.length ? (
        <p className="text-meta text-tertiary">
          {t("DashboardPayments.counterparty.directoryCapped", {
            count: initialCounterparties.length,
            total,
          })}
        </p>
      ) : null}
      {rows.length === 0 ? (
        <p className="py-12 text-center text-body text-tertiary">
          {t("DashboardPayments.counterparty.noMatches")}
        </p>
      ) : (
        <div className="overflow-x-auto">
          <Table className="min-w-[760px] rounded-none border-0" data-counterparty-directory-table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("DashboardPayments.counterparty.name")}</TableHead>
                <TableHead>{t("DashboardPayments.counterparty.type")}</TableHead>
                <TableHead>{t("DashboardPayments.counterparty.externalId")}</TableHead>
                <TableHead>{t("DashboardPayments.counterparty.address")}</TableHead>
                <TableHead>{t("DashboardPayments.recurring.created")}</TableHead>
                <TableHead className="w-12">
                  <span className="sr-only">
                    {t("DashboardPayments.counterparty.counterpartyActions")}
                  </span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((counterparty) => {
                const addresses = addressesByCounterparty.get(counterparty.id) ?? [];
                const href = counterpartyHref(counterparty.id);
                return (
                  <TableRow
                    key={counterparty.id}
                    className="cursor-pointer"
                    onClick={() => router.push(href)}
                  >
                    <TableCell className="max-w-64 text-body text-primary">
                      <Link
                        href={href}
                        className="block truncate focus-visible:underline focus-visible:outline-none"
                        onClick={(event) => event.stopPropagation()}
                      >
                        {counterparty.displayName}
                      </Link>
                    </TableCell>
                    <TableCell className="text-body text-secondary">
                      {typeLabel(counterparty.entityType)}
                    </TableCell>
                    <TableCell
                      className={
                        counterparty.externalId
                          ? "text-body text-primary"
                          : "text-body text-tertiary"
                      }
                    >
                      <span className="block max-w-48 truncate">
                        {counterparty.externalId ?? t("Shared.SharedComponents.notSet")}
                      </span>
                    </TableCell>
                    <TableCell className="text-body">
                      {addresses.length === 0 ? (
                        <span className="text-tertiary">
                          {t("DashboardPayments.counterparty.noAddress")}
                        </span>
                      ) : (
                        // biome-ignore lint/a11y/noStaticElementInteractions: Keeps copy clicks from opening the row.
                        // biome-ignore lint/a11y/useKeyWithClickEvents: The copy button inside handles the keyboard.
                        <span
                          className="inline-flex items-center gap-1.5 whitespace-nowrap text-primary"
                          onClick={(event) => event.stopPropagation()}
                        >
                          <span title={addresses[0]}>{shortenAddress(addresses[0])}</span>
                          <WalletMetadataCopyButton
                            value={addresses[0]}
                            label={t("DashboardPayments.counterparty.address")}
                          />
                          {addresses.length > 1 ? (
                            <span className="text-secondary">
                              {t("DashboardPayments.counterparty.andMore", {
                                count: addresses.length - 1,
                              })}
                            </span>
                          ) : null}
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-body whitespace-nowrap text-secondary">
                      {formatDate(counterparty.createdAt, locale)}
                    </TableCell>
                    <TableCell className="text-right">
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            aria-label={t("DashboardPayments.counterparty.counterpartyActions")}
                            onClick={(event) => event.stopPropagation()}
                          >
                            <MoreHorizontalIcon />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent onClick={(event) => event.stopPropagation()}>
                          <DropdownMenuItem
                            className="text-xs [&_svg]:size-3.5"
                            onSelect={() => router.push(href)}
                          >
                            <UserIcon />
                            {t("DashboardPayments.counterparty.manageCounterparty")}
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            className="text-xs text-error focus:text-error [&_svg]:size-3.5"
                            onSelect={() => setPendingDelete(counterparty)}
                          >
                            <Trash2Icon />
                            {t("DashboardPayments.counterparty.deleteCounterparty")}
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
      {filtered.length > pageSize ? (
        <ArrowPagination page={currentPage} pageCount={pageCount} onPageChange={setPage} />
      ) : null}
      <DeleteCounterpartyDialog
        isOpen={pendingDelete !== null}
        displayName={pendingDelete?.displayName ?? null}
        onConfirm={confirmDelete}
        onClose={() => setPendingDelete(null)}
      />
    </DashboardWorkspaceOverviewPanel>
  );
}
