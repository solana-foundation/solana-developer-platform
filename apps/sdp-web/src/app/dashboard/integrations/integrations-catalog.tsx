"use client";

import type { ComplianceProviderId, OrganizationRpcProvider, RampProviderId } from "@sdp/types";
import { SearchIcon } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import type { CustodyProviderAvailability } from "@/app/dashboard/custody/provider-display-status";
import { WalletProviderMark } from "@/app/dashboard/custody/wallet-provider-mark";
import { RpcProviderMark } from "@/app/dashboard/onboarding/rpc-provider-mark";
import { DashboardNavigationLink } from "@/components/dashboard-navigation-link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useTranslations } from "@/i18n/provider";
import { cn } from "@/lib/utils";
import {
  countByFamily,
  type FamilyFilter,
  type FilterableIntegration,
  hasActiveFilters,
  INTEGRATION_FAMILIES,
  type IntegrationFamily,
  type IntegrationFilters,
  matchesFilters,
  NO_FILTERS,
  type StatusFilter,
} from "./integrations-filter";
import type { IntegrationEntry, IntegrationStatus } from "./integrations-status";

type Translate = ReturnType<typeof useTranslations>;

const STATUS_FILTERS: StatusFilter[] = ["all", "active", "available", "request_access"];

function statusLabel(status: IntegrationStatus | "all", t: Translate): string {
  switch (status) {
    case "all":
      return t("Shared.integrations.filterAllStatuses");
    case "active":
      return t("Shared.integrations.statusActive");
    case "available":
      return t("Shared.integrations.statusAvailable");
    case "pending":
      return t("Shared.integrations.statusPending");
    case "request_access":
      return t("Shared.integrations.statusRequestAccess");
    default:
      return t("Shared.integrations.statusNotAvailable");
  }
}

function StatusBadge({ status, t }: { status: IntegrationStatus; t: Translate }) {
  return (
    <span
      className={cn(
        "rounded-full px-3 py-1 text-xs font-medium",
        status === "active"
          ? "bg-surface-raised text-secondary ring-1 ring-border-subtle"
          : status === "unavailable"
            ? "bg-fill-subtle text-tertiary"
            : "bg-fill-subtle text-secondary"
      )}
    >
      {statusLabel(status, t)}
    </span>
  );
}

function FilterPill({
  active,
  children,
  onClick,
}: {
  active: boolean;
  children: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "rounded-full px-3.5 py-1.5 text-sm font-medium transition-colors motion-reduce:transition-none",
        active ? "bg-primary text-on-primary" : "bg-fill-subtle text-secondary hover:bg-fill-strong"
      )}
    >
      {children}
    </button>
  );
}

interface IntegrationRowModel extends FilterableIntegration {
  icon: ReactNode;
  description?: string;
  action?: ReactNode;
}

function IntegrationCard({ row, t }: { row: IntegrationRowModel; t: Translate }) {
  return (
    <li
      className="flex flex-col gap-3 rounded-2xl border border-border-default bg-surface-raised p-5"
      data-integration-row="true"
      data-integration-status={row.status}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-fill-strong">
            {row.icon}
          </span>
          <span className="truncate text-base font-medium text-primary">{row.label}</span>
        </div>
        <StatusBadge status={row.status} t={t} />
      </div>
      {row.description ? (
        <p className="min-h-10 text-sm leading-5 text-tertiary">{row.description}</p>
      ) : (
        <span className="min-h-10" aria-hidden />
      )}
      {row.action ? <div>{row.action}</div> : null}
    </li>
  );
}

function NeutralMark({ label }: { label: string }) {
  return (
    <span aria-hidden className="text-sm font-semibold text-secondary">
      {label.slice(0, 2).toUpperCase()}
    </span>
  );
}

function familyLabelKey(family: IntegrationFamily) {
  return (
    {
      custody: "Shared.integrations.custodyTitle",
      rpc: "Shared.integrations.rpcTitle",
      ramps: "Shared.integrations.rampsTitle",
      compliance: "Shared.integrations.complianceTitle",
    } as const
  )[family];
}

function familyDescriptionKey(family: IntegrationFamily) {
  return (
    {
      custody: "Shared.integrations.custodyDescription",
      rpc: "Shared.integrations.rpcDescription",
      ramps: "Shared.integrations.rampsDescription",
      compliance: "Shared.integrations.complianceDescription",
    } as const
  )[family];
}

export function IntegrationsCatalog({
  custody,
  rpc,
  ramps,
  compliance,
}: {
  /** `null` when the connected-provider lookup failed: state unknown, not empty. */
  custody: CustodyProviderAvailability[] | null;
  rpc: IntegrationEntry<OrganizationRpcProvider>[];
  ramps: IntegrationEntry<RampProviderId>[];
  compliance: IntegrationEntry<ComplianceProviderId>[];
}) {
  const t = useTranslations();
  const [filters, setFilters] = useState<IntegrationFilters>(NO_FILTERS);

  const rows = useMemo<IntegrationRowModel[]>(() => {
    const custodyRows: IntegrationRowModel[] = (custody ?? []).map((provider) => ({
      family: "custody",
      provider: provider.entry.id,
      label: provider.entry.label,
      status: provider.status,
      icon: <WalletProviderMark provider={provider.entry.id} size="sm" />,
      description: t(provider.entry.descriptionKey),
      action:
        provider.status === "active" ? (
          <Button asChild variant="secondary" size="sm">
            <DashboardNavigationLink href="/dashboard/wallets">
              {t("Shared.integrations.ctaManage")}
            </DashboardNavigationLink>
          </Button>
        ) : provider.status === "available" ? (
          <Button asChild variant="secondary" size="sm">
            <DashboardNavigationLink
              href={`/dashboard/wallets/setup?provider=${provider.entry.id}`}
            >
              {t("Shared.integrations.ctaConfigure")}
            </DashboardNavigationLink>
          </Button>
        ) : provider.status === "request_access" &&
          provider.entry.storedCredentialSetup.mode === "request_access" ? (
          <Button asChild variant="secondary" size="sm">
            <a
              href={provider.entry.storedCredentialSetup.requestAccessUrl}
              target="_blank"
              rel="noreferrer noopener"
            >
              {t("Shared.integrations.ctaRequestAccess")}
            </a>
          </Button>
        ) : undefined,
    }));

    // Non-custody rows carry no per-row action on purpose. Repeating one
    // generic page link on every row read as noise; the destination that owns
    // the work is linked once at the section level instead.
    const rpcRows: IntegrationRowModel[] = rpc.map((provider) => ({
      family: "rpc",
      provider: provider.provider,
      label: provider.label,
      status: provider.status,
      icon: <RpcProviderMark provider={provider.provider} />,
      description: provider.descriptionKey ? t(provider.descriptionKey) : undefined,
    }));
    const rampRows: IntegrationRowModel[] = ramps.map((provider) => ({
      family: "ramps",
      provider: provider.provider,
      label: provider.label,
      status: provider.status,
      icon: <NeutralMark label={provider.label} />,
      description: provider.descriptionKey ? t(provider.descriptionKey) : undefined,
    }));
    const complianceRows: IntegrationRowModel[] = compliance.map((provider) => ({
      family: "compliance",
      provider: provider.provider,
      label: provider.label,
      status: provider.status,
      icon: <NeutralMark label={provider.label} />,
      description: provider.descriptionKey ? t(provider.descriptionKey) : undefined,
    }));

    return [...custodyRows, ...rpcRows, ...rampRows, ...complianceRows];
  }, [custody, rpc, ramps, compliance, t]);

  const familyCounts = useMemo(() => countByFamily(rows), [rows]);
  const visible = rows.filter((row) => matchesFilters(row, filters));
  const filtered = hasActiveFilters(filters);

  const familyPills: FamilyFilter[] = ["all", ...INTEGRATION_FAMILIES];

  return (
    <div className="mx-auto w-full max-w-4xl space-y-8 px-4 py-6 md:px-6">
      <p className="max-w-2xl text-sm leading-6 text-tertiary">
        {t("Shared.integrations.pageDescription")}
      </p>

      <div className="space-y-3" data-integrations-filters="true">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="relative w-full max-w-md">
            <SearchIcon
              aria-hidden
              className="pointer-events-none absolute top-1/2 left-4 size-4 -translate-y-1/2 text-tertiary"
            />
            <Input
              type="search"
              value={filters.query}
              onChange={(event) => setFilters({ ...filters, query: event.currentTarget.value })}
              placeholder={t("Shared.integrations.searchPlaceholder")}
              aria-label={t("Shared.integrations.searchPlaceholder")}
              className="h-11 rounded-2xl border-border-default bg-surface-raised pl-11 shadow-none"
            />
          </div>
          {filtered ? (
            <Button variant="ghost" size="sm" onClick={() => setFilters(NO_FILTERS)}>
              {t("Shared.integrations.clearFilters")}
            </Button>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
          <div className="flex flex-wrap items-center gap-2" data-integrations-family-pills="true">
            {familyPills.map((family) => (
              <FilterPill
                key={family}
                active={filters.family === family}
                onClick={() => setFilters({ ...filters, family })}
              >
                {family === "all"
                  ? t("Shared.integrations.filterAllFamilies")
                  : `${t(familyLabelKey(family))} · ${familyCounts[family]}`}
              </FilterPill>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2" data-integrations-status-pills="true">
            {STATUS_FILTERS.map((status) => (
              <FilterPill
                key={status}
                active={filters.status === status}
                onClick={() => setFilters({ ...filters, status })}
              >
                {statusLabel(status, t)}
              </FilterPill>
            ))}
          </div>
        </div>
      </div>

      {visible.length === 0 && custody !== null ? (
        <div
          className="rounded-2xl border border-border-default bg-surface-raised px-6 py-10 text-center"
          data-integrations-empty="true"
        >
          <p className="text-base font-medium text-primary">
            {t("Shared.integrations.emptyTitle")}
          </p>
          <p className="mt-1 text-sm leading-6 text-tertiary">
            {t("Shared.integrations.emptyBody")}
          </p>
          <Button variant="secondary" className="mt-5" onClick={() => setFilters(NO_FILTERS)}>
            {t("Shared.integrations.clearFilters")}
          </Button>
        </div>
      ) : null}

      {INTEGRATION_FAMILIES.map((family) => {
        const familyRows = visible.filter((row) => row.family === family);
        const custodyUnknown = family === "custody" && custody === null;
        if (familyRows.length === 0 && !custodyUnknown) {
          return null;
        }

        return (
          <section key={family} className="space-y-4">
            <div className="flex flex-wrap items-end justify-between gap-2">
              <div className="space-y-1">
                <h2 className="text-lg font-medium tracking-tight text-primary">
                  {t(familyLabelKey(family))}
                </h2>
                <p className="text-sm leading-5 text-tertiary">{t(familyDescriptionKey(family))}</p>
              </div>
              {family === "rpc" ? (
                <Button asChild variant="ghost" size="sm">
                  <DashboardNavigationLink href="/dashboard/settings">
                    {t("Shared.integrations.rpcSectionAction")}
                  </DashboardNavigationLink>
                </Button>
              ) : null}
            </div>

            {custodyUnknown ? (
              <div
                role="alert"
                className="rounded-2xl border border-border-default bg-fill-subtle px-5 py-4 text-sm leading-6 text-secondary"
              >
                {t("Shared.integrations.custodyUnavailable")}
              </div>
            ) : null}

            <ul className="grid gap-3 md:grid-cols-2">
              {familyRows.map((row) => (
                <IntegrationCard key={`${row.family}:${row.provider}`} row={row} t={t} />
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
