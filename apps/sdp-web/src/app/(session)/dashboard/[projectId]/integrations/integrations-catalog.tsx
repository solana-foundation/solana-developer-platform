"use client";

import {
  type IntegrationState,
  isConfigurableIntegrationStatus,
  type ProjectIntegrationFamily,
  type ProjectIntegrations,
} from "@sdp/types/integrations";
import { Button } from "@sdp/ui/button";
import { cn } from "@sdp/ui/cn";
import { InfoHint } from "@sdp/ui/info-hint";
import { SearchInput } from "@sdp/ui/search-input";
import { ChevronRightIcon, CircleCheckIcon } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import {
  DashboardHeaderTabsTrailing,
  useHiddenHeaderTabs,
} from "@/components/dashboard-header-tabs";
import { useTranslations } from "@/i18n/provider";
import { useDashboardTab } from "@/lib/dashboard-url-state";
import { useProjectHref } from "@/lib/use-dashboard-project";
import {
  INTEGRATION_FAMILY_COPY_KEYS,
  type IntegrationRow,
  type IntegrationSection,
  integrationSections,
} from "./integration-sections";

type Translate = ReturnType<typeof useTranslations>;

// Mark, name, category, state, chevron: one grid so every row's columns line up.
const ROW_COLUMNS =
  "grid grid-cols-[2.75rem_minmax(0,1fr)_auto_1rem] items-center gap-x-3 md:grid-cols-[2.75rem_minmax(0,1fr)_11rem_10rem_1rem]";

function isProjectIntegrationFamily(value: string): value is ProjectIntegrationFamily {
  return Object.hasOwn(INTEGRATION_FAMILY_COPY_KEYS, value);
}

function StateLabel({ state, t }: { state: IntegrationState; t: Translate }) {
  switch (state.status) {
    case "connected":
      return (
        <span className="inline-flex items-center gap-1.5 text-success">
          <CircleCheckIcon aria-hidden className="size-4 shrink-0" />
          {t("Shared.integrations.stateConnected")}
        </span>
      );
    case "provided":
      return <span className="text-secondary">{t("Shared.integrations.stateProvided")}</span>;
    case "not_configured":
      return <span className="text-secondary">{t("Shared.integrations.stateNotConfigured")}</span>;
    default: {
      const exhaustive: never = state;
      throw new Error(`Unknown integration state: ${String(exhaustive)}`);
    }
  }
}

function IntegrationRowItem({ row, t }: { row: IntegrationRow; t: Translate }) {
  const href = useProjectHref();
  return (
    <li
      className={cn(
        ROW_COLUMNS,
        "group relative isolate py-3",
        row.href !== null &&
          "before:absolute before:inset-y-0 before:-inset-x-3 before:-z-10 before:rounded-lg before:bg-fill-subtle before:opacity-0 before:transition-opacity before:content-[''] hover:before:opacity-100 has-[:focus-visible]:before:opacity-100 has-[:focus-visible]:before:ring-2 has-[:focus-visible]:before:ring-primary motion-reduce:before:transition-none"
      )}
      data-integration-row={row.key}
      data-integration-status={row.state.status}
    >
      {row.icon}
      <div className="flex min-w-0 flex-col">
        {row.href === null ? (
          <span className="truncate text-sm leading-5 font-medium text-primary">{row.label}</span>
        ) : (
          <Link
            href={href(row.href)}
            className="truncate text-sm leading-5 font-medium text-primary after:absolute after:inset-y-0 after:-inset-x-3 after:content-[''] focus-visible:outline-none"
          >
            {row.label}
          </Link>
        )}
        <p className="truncate text-xs leading-4 text-secondary">{row.description}</p>
      </div>
      <span className="hidden truncate text-xs text-secondary md:block">{row.category}</span>
      <span className="flex justify-end text-xs">
        <StateLabel state={row.state} t={t} />
      </span>
      <span className="flex justify-end">
        {row.href === null ? null : (
          <ChevronRightIcon
            aria-hidden
            className="size-4 text-tertiary transition-transform group-hover:translate-x-0.5 group-hover:text-secondary motion-reduce:transition-none"
          />
        )}
      </span>
    </li>
  );
}

function SectionSummary({ section, t }: { section: IntegrationSection; t: Translate }) {
  const configurable = section.rows.filter((row) =>
    isConfigurableIntegrationStatus(row.state.status)
  );
  if (configurable.length === 0) {
    return null;
  }
  const connected = configurable.filter((row) => row.state.status === "connected").length;
  return (
    <span className="text-sm text-secondary">
      {t("Shared.integrations.connectedCount", { connected, total: configurable.length })}
    </span>
  );
}

function IntegrationSectionBlock({ section, t }: { section: IntegrationSection; t: Translate }) {
  return (
    <section className="space-y-2" data-integration-section={section.family}>
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-2">
          <h2 className="text-lg font-medium tracking-tight text-primary">{section.title}</h2>
          <InfoHint text={section.description} />
        </div>
        <SectionSummary section={section} t={t} />
      </div>
      <ul className="divide-y divide-border-subtle">
        {section.rows.map((row) => (
          <IntegrationRowItem key={row.key} row={row} t={t} />
        ))}
      </ul>
    </section>
  );
}

function matchesQuery(row: IntegrationRow, query: string): boolean {
  return row.label.toLowerCase().includes(query) || row.provider.toLowerCase().includes(query);
}

export function IntegrationsCatalog({ integrations }: { integrations: ProjectIntegrations }) {
  const t = useTranslations();
  const urlTab = useDashboardTab();
  const [query, setQuery] = useState("");
  const sections = useMemo(() => integrationSections(integrations, t), [integrations, t]);

  // A family with no provider for this project loses its tab, and a link to it lands on All.
  const presentFamilies = new Set<string>(sections.map((section) => section.family));
  useHiddenHeaderTabs(
    Object.keys(INTEGRATION_FAMILY_COPY_KEYS).filter((family) => !presentFamilies.has(family))
  );
  const tabFamily =
    urlTab !== null && isProjectIntegrationFamily(urlTab) && presentFamilies.has(urlTab)
      ? urlTab
      : null;
  const normalizedQuery = query.trim().toLowerCase();
  const visibleSections = sections
    .filter((section) => tabFamily === null || section.family === tabFamily)
    .map((section) => ({
      ...section,
      rows: section.rows.filter((row) => matchesQuery(row, normalizedQuery)),
    }))
    .filter((section) => section.rows.length > 0);

  return (
    <div className="w-full space-y-10" data-integrations-catalog="true">
      <DashboardHeaderTabsTrailing>
        <div className="w-56 max-w-full">
          <SearchInput
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            placeholder={t("Shared.integrations.searchPlaceholder")}
          />
        </div>
      </DashboardHeaderTabsTrailing>
      {visibleSections.map((section) => (
        <IntegrationSectionBlock key={section.family} section={section} t={t} />
      ))}
      {visibleSections.length === 0 ? (
        <div className="py-10 text-center" data-integrations-empty="search">
          <p className="text-base font-medium text-primary">
            {t("Shared.integrations.emptyTitle")}
          </p>
          <Button variant="secondary" className="mt-4" onClick={() => setQuery("")}>
            {t("Shared.integrations.clearSearch")}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
