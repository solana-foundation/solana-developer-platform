"use client";

import type { ComplianceProviderId, OrganizationRpcProvider, RampProviderId } from "@sdp/types";
import {
  ArrowLeftRightIcon,
  ChevronRight,
  CircleDotDashedIcon,
  ShieldCheckIcon,
  VenetianMaskIcon,
  WalletIcon,
} from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { type ReactNode, useMemo, useState } from "react";
import type { CustodyProviderAvailability } from "@/app/dashboard/custody/provider-display-status";
import { WalletProviderMark } from "@/app/dashboard/custody/wallet-provider-mark";
import { RpcProviderMark } from "@/app/dashboard/integrations/rpc-provider-mark";
import { Button } from "@/components/ui/button";
import { SearchInput } from "@/components/ui/search-input";
import { useTranslations } from "@/i18n/provider";
import { COMPLIANCE_PROVIDER_LOGOS } from "@/lib/compliance";
import { useDashboardTab } from "@/lib/dashboard-url-state";
import { RAMP_PROVIDER_LOGOS } from "@/lib/ramps";
import { cn } from "@/lib/utils";
import {
  type ConnectionState,
  connectionState,
  type FilterableIntegration,
  INTEGRATION_FAMILIES,
  type IntegrationFamily,
} from "./integrations-filter";
import type { IntegrationEntry, IntegrationStatus, PrivacyProviderId } from "./integrations-status";
import { DASHBOARD_INTEGRATIONS_SUBNAV_HREFS } from "@/lib/dashboard-navigation-loading";

type Translate = ReturnType<typeof useTranslations>;
const EMPTY_PRIVACY: IntegrationEntry<PrivacyProviderId>[] = [];

/**
 * The pill says precisely what this provider is; the chips group. A chip is a
 * question ("show me what is on"), a pill is an answer, and the answer for a
 * deployment-provisioned rail is not the same as for a key this organization
 * connected itself -- the detail page says so in as many words a click later,
 * so a card claiming "Connected" would be contradicted by the page it opens.
 *
 * Same labels the detail page uses, so a provider never changes its word
 * between the two surfaces.
 */
function statusLabel(status: IntegrationStatus, t: Translate): string {
  switch (status) {
    case "active":
      return t("Shared.integrations.statusActive");
    case "available":
      return t("Shared.integrations.statusAvailable");
    case "enabled":
      return t("Shared.integrations.statusEnabled");
    case "request_access":
      return t("Shared.integrations.statusRequestAccess");
    case "unknown":
      return t("Shared.integrations.statusUnknown");
    default:
      return t("Shared.integrations.statusNotConfigured");
  }
}

/**
 * Colour, unlike the wording, does track the chips: everything the "Connected"
 * chip selects is green, so scanning the grid and filtering it answer the same
 * question. That was the defect worth fixing -- three green cards vanished
 * behind a chip whose colour they already carried.
 *
 * The connected token pair is the shared `Badge` component's `success`, so a
 * provider looks the same here as its connection does on the detail page.
 */
const STATE_CLASS_NAMES: Record<ConnectionState, string> = {
  connected: "bg-success-bg text-success",
  not_connected: "bg-fill-subtle text-tertiary",
  on_request: "bg-fill-subtle text-secondary",
  unknown: "bg-status-warning-bg text-status-warning-text",
};

function StatusBadge({ status, t }: { status: IntegrationStatus; t: Translate }) {
  const state = connectionState(status);
  return (
    <span
      className={cn(
        "shrink-0 whitespace-nowrap rounded-full px-3 py-1 text-xs font-medium",
        STATE_CLASS_NAMES[state]
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
      privacy: "Shared.integrations.privacyTitle",
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
      privacy: "Shared.integrations.privacyDescription",
    } as const
  )[family];
}

const FAMILY_ICONS = {
  custody: WalletIcon,
  rpc: CircleDotDashedIcon,
  ramps: ArrowLeftRightIcon,
  compliance: ShieldCheckIcon,
  privacy: VenetianMaskIcon,
} satisfies Record<IntegrationFamily, typeof WalletIcon>;

function IntegrationsHub({
  families,
  t,
}: {
  families: readonly IntegrationFamily[];
  t: Translate;
}) {
  return (
    <section
      className="min-w-0 rounded-lg border border-border-default bg-surface-raised p-4"
      data-integrations-hub="true"
    >
      <h2 className="text-base font-semibold tracking-[-0.01em] text-primary">
        {t("Shared.integrations.filterAllFamilies")}
      </h2>
      <div className="mt-4 grid grid-cols-2 gap-2 xl:grid-cols-3">
        {families.map((integrationFamily) => {
          const Icon = FAMILY_ICONS[integrationFamily];
          return (
            <Link
              key={integrationFamily}
              href={DASHBOARD_INTEGRATIONS_SUBNAV_HREFS[integrationFamily]}
              data-integration-hub-action={integrationFamily}
              className="group flex min-h-36 min-w-0 flex-col items-center justify-center rounded-md border border-border-default px-3 py-4 text-center transition-colors hover:border-border-strong hover:bg-fill-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary motion-reduce:transition-none xl:min-h-44"
            >
              <span className="inline-flex size-12 shrink-0 items-center justify-center rounded-full bg-fill-subtle text-primary transition-colors group-hover:bg-fill-strong">
                <Icon className="size-5" aria-hidden="true" />
              </span>
              <span className="mt-3 text-base font-semibold text-primary">
                {t(familyLabelKey(integrationFamily))}
              </span>
              <span className="mt-1 text-sm leading-5 text-secondary">
                {t(familyDescriptionKey(integrationFamily))}
              </span>
            </Link>
          );
        })}
      </div>
    </section>
  );
}

export function IntegrationsCatalog({
  custody,
  rpc,
  ramps,
  compliance,
  privacy = EMPTY_PRIVACY,
  enabledFamilies = INTEGRATION_FAMILIES,
}: {
  /** `null` when the connected-provider lookup failed: state unknown, not empty. */
  custody: CustodyProviderAvailability[] | null;
  rpc: IntegrationEntry<OrganizationRpcProvider>[];
  ramps: IntegrationEntry<RampProviderId>[];
  compliance: IntegrationEntry<ComplianceProviderId>[];
  privacy?: IntegrationEntry<PrivacyProviderId>[];
  /** Mirrors the sidebar: a disabled module does not get a hub entry or tab. */
  enabledFamilies?: readonly IntegrationFamily[];
}) {
  const t = useTranslations();
  // The family axis lives in the Integrations sidebar submenu (`?tab=`).
  // Unknown and disabled values fall back to the hub rather than exposing an
  // integration category the organization cannot use.
  const urlTab = useDashboardTab();
  const family: IntegrationFamily | "all" =
    urlTab !== null &&
    (INTEGRATION_FAMILIES as string[]).includes(urlTab) &&
    enabledFamilies.includes(urlTab as IntegrationFamily)
      ? (urlTab as IntegrationFamily)
      : "all";
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

    const privacyRows: IntegrationRowModel[] = privacy.map((provider) => ({
      family: "privacy",
      provider: provider.provider,
      label: provider.label,
      status: provider.status,
      icon: <VenetianMaskIcon aria-hidden className="size-5 text-secondary" strokeWidth={1.8} />,
      description: provider.descriptionKey ? t(provider.descriptionKey) : undefined,
    }));

    return [...custodyRows, ...rpcRows, ...rampRows, ...complianceRows, ...privacyRows];
  }, [custody, rpc, ramps, compliance, privacy, t]);

  const visible = rows.filter(
    (row) =>
      row.family === family &&
      (query.trim().length === 0 ||
        row.label.toLowerCase().includes(query.trim().toLowerCase()) ||
        row.provider.toLowerCase().includes(query.trim().toLowerCase()))
  );

  return (
    <div className="w-full space-y-6 px-4 py-5 md:px-6">
      {family === "all" ? <IntegrationsHub families={enabledFamilies} t={t} /> : null}

      {family !== "all" ? (
        <div className="flex justify-end">
          <div className="w-full max-w-xs">
            <SearchInput
              value={query}
              onChange={(event) => setQuery(event.currentTarget.value)}
              placeholder={t("Shared.integrations.searchPlaceholder")}
            />
          </div>
        </div>
      ) : null}

      {family !== "all" && visible.length === 0 && custody !== null ? (
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
          <Button variant="secondary" className="mt-5" onClick={() => setQuery("")}>
            {t("Shared.integrations.clearFilters")}
          </Button>
        </div>
      ) : null}

      {family !== "all" ? (
        <section className="space-y-4">
          <div className="space-y-1">
            <h2 className="text-lg font-medium tracking-tight text-primary">
              {t(familyLabelKey(family))}
            </h2>
            <p className="text-sm leading-5 text-tertiary">{t(familyDescriptionKey(family))}</p>
          </div>

          {family === "custody" && custody === null ? (
            <div
              role="alert"
              className="rounded-2xl border border-border-default bg-fill-subtle px-5 py-4 text-sm leading-6 text-secondary"
            >
              {t("Shared.integrations.custodyUnavailable")}
            </div>
          ) : null}

          <ul className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {visible.map((row) => (
              <IntegrationCard key={`${row.family}:${row.provider}`} row={row} t={t} />
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
