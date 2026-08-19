"use client";

import type { ComplianceProviderId, OrganizationRpcProvider, RampProviderId } from "@sdp/types";
import { SegmentedControl } from "@solana/design-system/segmented-control";
import { ChevronRight } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { type ReactNode, useMemo, useState } from "react";
import type { CustodyProviderAvailability } from "@/app/dashboard/custody/provider-display-status";
import { WalletProviderMark } from "@/app/dashboard/custody/wallet-provider-mark";
import { RpcProviderMark } from "@/app/dashboard/onboarding/rpc-provider-mark";
import { Button } from "@/components/ui/button";
import { SearchInput } from "@/components/ui/search-input";
import { useTranslations } from "@/i18n/provider";
import { COMPLIANCE_PROVIDER_LOGOS } from "@/lib/compliance";
import { useDashboardTab } from "@/lib/dashboard-url-state";
import { RAMP_PROVIDER_LOGOS } from "@/lib/ramps";
import { cn } from "@/lib/utils";
import {
  type FamilyFilter,
  type FilterableIntegration,
  INTEGRATION_FAMILIES,
  type IntegrationFamily,
  matchesFilters,
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
      return t("Shared.integrations.filterAll");
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
          <Link
            href={`/dashboard/integrations/${row.provider}`}
            className="truncate pt-2 text-base font-medium text-primary after:absolute after:inset-0 after:content-['']"
          >
            {row.label}
          </Link>
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
  // The family axis lives in the header tabs (`?tab=`, same contract as
  // policies); unknown tab values fall back to every family. Status and search
  // stay in-page as the secondary filter row.
  const urlTab = useDashboardTab();
  const family: FamilyFilter =
    urlTab !== null && (INTEGRATION_FAMILIES as string[]).includes(urlTab)
      ? (urlTab as IntegrationFamily)
      : "all";
  const [status, setStatus] = useState<StatusFilter>("all");
  const [query, setQuery] = useState("");

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

  const visible = rows.filter((row) => matchesFilters(row, { family, status, query }));
  const clearFilters = () => {
    setStatus("all");
    setQuery("");
  };

  return (
    <div className="w-full space-y-6 px-4 py-5 md:px-6">
      {/* No lead-in paragraph: each section explains itself, and the header
          tabs already frame the page — content starts at the toolbar. The
          status group is one contained segmented control (the secondary pill
          tabs), so it can never shed an orphaned pill onto its own wrap line;
          on narrow viewports it scrolls within its strip instead. */}
      <div
        className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between"
        data-integrations-filters="true"
      >
        <div
          className="-mx-4 overflow-x-auto px-4 [scrollbar-width:none] md:-mx-6 md:px-6 xl:mx-0 xl:px-0"
          data-integrations-status-pills="true"
        >
          <SegmentedControl
            aria-label={t("Shared.integrations.filterByStatus")}
            items={STATUS_FILTERS.map((option) => ({
              value: option,
              label: statusLabel(option, t),
            }))}
            value={status}
            // Re-clicking the active segment can emit an empty value from the
            // underlying toggle group; a status filter always has a selection.
            onValueChange={(value) => value && setStatus(value as StatusFilter)}
          />
        </div>
        <div className="w-full max-w-xs xl:w-64 xl:shrink-0">
          <SearchInput
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            placeholder={t("Shared.integrations.searchPlaceholder")}
          />
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
          <Button variant="secondary" className="mt-5" onClick={clearFilters}>
            {t("Shared.integrations.clearFilters")}
          </Button>
        </div>
      ) : null}

      {INTEGRATION_FAMILIES.map((sectionFamily) => {
        const familyRows = visible.filter((row) => row.family === sectionFamily);
        // The unknown-state alert belongs to the custody section, so it only
        // renders where that section is in view — not under another tab.
        const custodyUnknown =
          sectionFamily === "custody" &&
          custody === null &&
          (family === "all" || family === "custody");
        if (familyRows.length === 0 && !custodyUnknown) {
          return null;
        }

        return (
          <section key={sectionFamily} className="space-y-4">
            <div className="flex flex-wrap items-end justify-between gap-2">
              <div className="space-y-1">
                <h2 className="text-lg font-medium tracking-tight text-primary">
                  {t(familyLabelKey(sectionFamily))}
                </h2>
                <p className="text-sm leading-5 text-tertiary">
                  {t(familyDescriptionKey(sectionFamily))}
                </p>
              </div>
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
