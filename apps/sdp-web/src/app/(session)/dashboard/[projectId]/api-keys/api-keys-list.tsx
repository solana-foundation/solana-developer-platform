"use client";

import { Button } from "@sdp/ui/button";
import { cn } from "@sdp/ui/cn";
import { FilterMenu, FilterMenuOptions } from "@sdp/ui/filter-menu";
import { ListEmptyState } from "@sdp/ui/list-empty-state";
import { ListToolbar } from "@sdp/ui/list-toolbar";
import { SearchInput } from "@sdp/ui/search-input";
import { TableCell } from "@sdp/ui/table";
import { Table, TableBody, TableHead, TableHeader, TableRow } from "@solana/design-system/table";
import { ChevronRightIcon, PlusIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import {
  PAYMENTS_TABLE_CELL,
  PAYMENTS_TABLE_HEAD,
} from "@/app/(session)/dashboard/[projectId]/payments/payments-table";
import { useLocale, useTranslations } from "@/i18n/provider";
import { useTimeZone } from "@/i18n/time-zone";
import { useProjectHref } from "@/lib/use-dashboard-project";
import { ApiKeyLifetimeText } from "./api-key-lifetime-text";
import {
  API_KEY_REACHES,
  API_KEY_STATUS_FILTERS,
  type ApiKeyListItem,
  type ApiKeyReach,
  type ApiKeyStatusFilter,
  apiKeyLifetime,
  apiKeyReach,
  apiKeyReachLabel,
  apiKeyStatusFilter,
  apiKeyWalletsLabel,
  formatLastUsed,
} from "./api-key-presentation";

function isStatusFilter(value: string | undefined): value is ApiKeyStatusFilter {
  return API_KEY_STATUS_FILTERS.some((filter) => filter === value);
}

function isReach(value: string | undefined): value is ApiKeyReach {
  return API_KEY_REACHES.some((reach) => reach === value);
}

function ApiKeyRow({ apiKey, now }: { apiKey: ApiKeyListItem; now: number }) {
  const t = useTranslations();
  const locale = useLocale();
  const timeZone = useTimeZone();
  const router = useRouter();
  const href = useProjectHref()(`/dashboard/api-keys/${encodeURIComponent(apiKey.id)}`);
  const lifetime = apiKeyLifetime(apiKey, now);
  const facts = [
    apiKeyReachLabel(apiKeyReach(apiKey.grants), t),
    apiKeyWalletsLabel(apiKey, t),
    ...(lifetime.kind === "stopping" ? [t("DashboardCustody.apiKeyPage.replaced")] : []),
  ];

  return (
    <TableRow className="cursor-pointer" onClick={() => router.push(href)} data-api-key={apiKey.id}>
      <TableCell className={cn(PAYMENTS_TABLE_CELL, "py-3")}>
        <span className="flex min-w-0 items-baseline gap-2">
          <Link
            href={href}
            className="truncate text-body font-medium text-primary focus-visible:underline focus-visible:outline-none"
            onClick={(event) => event.stopPropagation()}
          >
            {apiKey.name}
          </Link>
          <span className="shrink-0 text-meta text-tertiary">{apiKey.keyPrefix}</span>
        </span>
        <span className="mt-0.5 block truncate text-meta text-secondary">{facts.join(" · ")}</span>
      </TableCell>
      <TableCell className={cn(PAYMENTS_TABLE_CELL, "text-right whitespace-nowrap text-secondary")}>
        {formatLastUsed(apiKey.lastUsedAt, now, locale, timeZone, t)}
      </TableCell>
      <TableCell className={cn(PAYMENTS_TABLE_CELL, "text-right whitespace-nowrap")}>
        <ApiKeyLifetimeText lifetime={lifetime} now={now} />
      </TableCell>
      <TableCell className="w-10 text-right">
        <ChevronRightIcon aria-hidden className="ml-auto size-4 text-tertiary" />
      </TableCell>
    </TableRow>
  );
}

/**
 * The project's keys, newest first, each row opening the key's page. Search matches a name or
 * prefix; the filters narrow by whether the key still works and by how much it may do.
 */
export function ApiKeysList({
  apiKeys,
  canManageApiKeys,
  now,
}: {
  apiKeys: ApiKeyListItem[];
  canManageApiKeys: boolean;
  /** When the server rendered the page, so relative times read the same once hydrated. */
  now: number;
}) {
  const t = useTranslations();
  const href = useProjectHref();
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<ApiKeyStatusFilter | undefined>(undefined);
  const [reach, setReach] = useState<ApiKeyReach | undefined>(undefined);

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return [...apiKeys]
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .filter(
        (key) =>
          needle === "" ||
          key.name.toLowerCase().includes(needle) ||
          key.keyPrefix.toLowerCase().includes(needle)
      )
      .filter(
        (key) => status === undefined || apiKeyStatusFilter(apiKeyLifetime(key, now)) === status
      )
      .filter((key) => reach === undefined || apiKeyReach(key.grants) === reach);
  }, [apiKeys, now, query, reach, status]);

  if (apiKeys.length === 0) {
    return (
      <ListEmptyState
        message={t("DashboardCustody.noApiKeysFound")}
        description={t("DashboardCustody.apiKeyPage.emptyDescription")}
        hidesPageAction
        action={
          canManageApiKeys ? (
            <Button asChild iconLeft={<PlusIcon className="size-4" />}>
              <Link href={href("/dashboard/api-keys/new")}>
                {t("DashboardCustody.apiKeyPage.createKey")}
              </Link>
            </Button>
          ) : null
        }
      />
    );
  }

  const sections = [
    {
      id: "status",
      label: t("DashboardCustody.status"),
      value:
        status === undefined ? undefined : t(`DashboardCustody.apiKeyPage.statusFilter.${status}`),
      content: (
        <FilterMenuOptions
          value={status}
          anyLabel={t("Shared.SharedComponents.any")}
          options={API_KEY_STATUS_FILTERS.map((value) => ({
            value,
            label: t(`DashboardCustody.apiKeyPage.statusFilter.${value}`),
          }))}
          onChange={(value) => setStatus(isStatusFilter(value) ? value : undefined)}
        />
      ),
    },
    {
      id: "access",
      label: t("DashboardCustody.access"),
      value: reach === undefined ? undefined : apiKeyReachLabel(reach, t),
      content: (
        <FilterMenuOptions
          value={reach}
          anyLabel={t("Shared.SharedComponents.any")}
          options={API_KEY_REACHES.map((value) => ({ value, label: apiKeyReachLabel(value, t) }))}
          onChange={(value) => setReach(isReach(value) ? value : undefined)}
        />
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-5">
      <ListToolbar
        filters={
          <FilterMenu
            label={t("Shared.SharedComponents.filter")}
            searchPlaceholder={t("Shared.SharedComponents.filterBy")}
            sections={sections}
          />
        }
      >
        <SearchInput
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          clear={{
            label: t("DashboardCustody.apiKeyPage.clearSearch"),
            onClear: () => setQuery(""),
          }}
          placeholder={t("DashboardCustody.apiKeyPage.searchPlaceholder")}
          className="min-w-0 flex-1 sm:w-56 sm:flex-none"
        />
      </ListToolbar>
      {rows.length === 0 ? (
        <p className="py-12 text-center text-body text-tertiary">
          {t("DashboardCustody.apiKeyPage.noMatches")}
        </p>
      ) : (
        <div className="-mx-3 overflow-x-auto">
          <Table className="min-w-[35rem] rounded-none border-0" data-api-keys-table>
            <TableHeader>
              <TableRow>
                <TableHead className={PAYMENTS_TABLE_HEAD}>
                  {t("DashboardCustody.apiKeyPage.key")}
                </TableHead>
                <TableHead className={cn(PAYMENTS_TABLE_HEAD, "text-right")}>
                  {t("DashboardCustody.lastUsed")}
                </TableHead>
                <TableHead className={cn(PAYMENTS_TABLE_HEAD, "text-right")}>
                  {t("DashboardCustody.expires")}
                </TableHead>
                <TableHead className="w-10">
                  <span className="sr-only">{t("DashboardCustody.apiKeyPage.openKey")}</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((apiKey) => (
                <ApiKeyRow key={apiKey.id} apiKey={apiKey} now={now} />
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
