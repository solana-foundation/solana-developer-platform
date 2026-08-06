"use client";

import type { ComplianceProviderId, OrganizationRpcProvider, RampProviderId } from "@sdp/types";
import { ChevronRight, Search } from "lucide-react";
import Image from "next/image";
import { type ReactNode, useMemo, useState } from "react";
import type { CustodyProviderAvailability } from "@/app/dashboard/custody/provider-display-status";
import { WalletProviderMark } from "@/app/dashboard/custody/wallet-provider-mark";
import { RpcProviderMark } from "@/app/dashboard/onboarding/rpc-provider-mark";
import { DashboardNavigationLink } from "@/components/dashboard-navigation-link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useTranslations } from "@/i18n/provider";
import { COMPLIANCE_PROVIDER_LOGOS } from "@/lib/compliance";
import { RAMP_PROVIDER_LOGOS } from "@/lib/ramps";
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

const STATUS_FILTERS: StatusFilter[] = [
  "all",
  "active",
  "available",
  "enabled",
  "request_access",
  "not_configured",
];

function statusLabel(status: IntegrationStatus | "all", t: Translate): string {
  switch (status) {
    case "all":
      return t("Shared.integrations.filterAllStatuses");
    case "active":
      return t("Shared.integrations.statusActive");
    case "available":
      return t("Shared.integrations.statusAvailable");
    case "enabled":
      return t("Shared.integrations.statusEnabled");
    case "request_access":
      return t("Shared.integrations.statusRequestAccess");
    default:
      return t("Shared.integrations.statusNotConfigured");
  }
}

function StatusBadge({ status, t }: { status: IntegrationStatus; t: Translate }) {
  return (
    <span
      className={cn(
        "shrink-0 whitespace-nowrap rounded-full px-3 py-1 text-xs font-medium",
        status === "active"
          ? "bg-surface-raised text-secondary ring-1 ring-border-subtle"
          : status === "not_configured"
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
}

function IntegrationCard({ row, t }: { row: IntegrationRowModel; t: Translate }) {
  // Cards browse; the detail page acts. Its header carries the state-correct
  // action, so repeating a button here was redundant, and the chevron is the
  // standing invitation that the whole card opens it.
  return (
    <li
      className="group relative flex items-start gap-3 rounded-2xl border border-border-default bg-surface-raised p-5 transition-colors hover:border-border-strong motion-reduce:transition-none"
      data-integration-row="true"
      data-integration-status={row.status}
    >
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-fill-strong">
        {row.icon}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex items-start justify-between gap-3">
          {/* Stretched link: the title anchors it and the overlay makes the
              whole card the click target. */}
          <DashboardNavigationLink
            href={`/dashboard/integrations/${row.provider}`}
            className="truncate pt-2 text-base font-medium text-primary after:absolute after:inset-0 after:content-['']"
          >
            {row.label}
          </DashboardNavigationLink>
          <StatusBadge status={row.status} t={t} />
        </div>
        {row.description ? (
          <p className="pr-6 text-sm leading-5 text-tertiary">{row.description}</p>
        ) : null}
      </div>
      <ChevronRight
        aria-hidden
        className="absolute right-4 bottom-4 size-4 text-tertiary transition-transform group-hover:translate-x-0.5 group-hover:text-secondary motion-reduce:transition-none"
      />
    </li>
  );
}

function LogoMark({ src, label }: { src: string; label: string }) {
  // Mirrors the wallet and RPC marks: logos sit on a white chip so dark-mode
  // artwork with transparent backgrounds stays legible.
  return (
    <span
      aria-hidden
      title={label}
      className="inline-flex h-7 w-7 items-center justify-center overflow-hidden rounded-md border border-border-subtle bg-[white]"
    >
      <span className="relative h-full w-full p-1">
        <Image src={src} alt="" fill sizes="28px" className="object-contain" />
      </span>
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
    }));

    // No card carries an action: the detail page's header owns the
    // state-correct one, and the section header links shared destinations.
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
      icon: <LogoMark src={RAMP_PROVIDER_LOGOS[provider.provider]} label={provider.label} />,
      description: provider.descriptionKey ? t(provider.descriptionKey) : undefined,
    }));
    const complianceRows: IntegrationRowModel[] = compliance.map((provider) => ({
      family: "compliance",
      provider: provider.provider,
      label: provider.label,
      status: provider.status,
      icon: <LogoMark src={COMPLIANCE_PROVIDER_LOGOS[provider.provider]} label={provider.label} />,
      description: provider.descriptionKey ? t(provider.descriptionKey) : undefined,
    }));

    return [...custodyRows, ...rpcRows, ...rampRows, ...complianceRows];
  }, [custody, rpc, ramps, compliance, t]);

  const familyCounts = useMemo(() => countByFamily(rows), [rows]);
  const visible = rows.filter((row) => matchesFilters(row, filters));
  const filtered = hasActiveFilters(filters);

  const familyPills: FamilyFilter[] = ["all", ...INTEGRATION_FAMILIES];

  return (
    <div className="w-full space-y-8 px-4 py-6 md:px-6">
      <p className="mx-auto max-w-2xl text-center text-sm leading-6 text-tertiary">
        {t("Shared.integrations.pageDescription")}
      </p>

      <div className="space-y-3" data-integrations-filters="true">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="w-full max-w-md">
            <Input
              type="search"
              value={filters.query}
              onChange={(event) => setFilters({ ...filters, query: event.currentTarget.value })}
              placeholder={t("Shared.integrations.searchPlaceholder")}
              aria-label={t("Shared.integrations.searchPlaceholder")}
              iconLeft={<Search />}
              // The DS input paints its border on an inner span via
              // --input-border-*, so border-* classes are inert here.
              className="h-10 rounded-[10px] bg-surface-raised [--input-border-hover:var(--color-border-strong)] [--input-border-idle:var(--color-border-default)] [--input-border-width:1px]"
            />
          </div>
          {filtered ? (
            <Button variant="ghost" size="sm" onClick={() => setFilters(NO_FILTERS)}>
              {t("Shared.integrations.clearFilters")}
            </Button>
          ) : null}
        </div>
        {/* Family and status are two independent axes; stacking them keeps the
            row from reading as one undifferentiated strip of pills. */}
        <div className="flex flex-col gap-2">
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

            <ul className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
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
