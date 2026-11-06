"use client";

import type { IntegrationState, ProjectIntegrations } from "@sdp/types/integrations";
import { cn } from "@sdp/ui/cn";
import { InfoHint } from "@sdp/ui/info-hint";
import { ChevronRightIcon, CircleCheckIcon } from "lucide-react";
import Link from "next/link";
import { useMemo } from "react";
import { useTranslations } from "@/i18n/provider";
import { useProjectHref } from "@/lib/use-dashboard-project";
import {
  type IntegrationRow,
  type IntegrationSection,
  integrationSections,
  isConfigurable,
} from "./integration-sections";

type Translate = ReturnType<typeof useTranslations>;

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

function IntegrationRowItem({
  row,
  showCategory,
  t,
}: {
  row: IntegrationRow;
  showCategory: boolean;
  t: Translate;
}) {
  const href = useProjectHref();
  return (
    <li
      className={cn(
        "group relative isolate flex items-center gap-4 py-4",
        row.href !== null &&
          "before:absolute before:inset-y-0 before:-inset-x-3 before:-z-10 before:rounded-lg before:bg-fill-subtle before:opacity-0 before:transition-opacity before:content-[''] hover:before:opacity-100 has-[:focus-visible]:before:opacity-100 motion-reduce:before:transition-none"
      )}
      data-integration-row={row.key}
      data-integration-status={row.state.status}
    >
      {row.icon}
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        {/* Stretched link: the name anchors it and the overlay makes the whole row the target. */}
        {row.href === null ? (
          <span className="truncate text-base font-medium text-primary">{row.label}</span>
        ) : (
          <Link
            href={href(row.href)}
            className="truncate text-base font-medium text-primary after:absolute after:inset-0 after:content-[''] focus-visible:outline-none"
          >
            {row.label}
          </Link>
        )}
        <p className="truncate text-sm text-tertiary">{row.description}</p>
      </div>
      {showCategory ? (
        <span className="hidden w-36 shrink-0 text-sm text-secondary md:block">{row.category}</span>
      ) : null}
      <span className="flex w-40 shrink-0 justify-end text-sm">
        <StateLabel state={row.state} t={t} />
      </span>
      <span className="flex w-4 shrink-0 justify-end">
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
  if (section.family === "rpc") {
    const primary = section.rows[0];
    return primary === undefined ? null : (
      <span className="flex items-center gap-1.5 text-sm text-secondary">
        {t("Shared.integrations.rpcServing", { provider: primary.label })}
        <InfoHint text={t("Shared.integrations.rpcServingHint")} />
      </span>
    );
  }
  const configurable = section.rows.filter((row) => isConfigurable(row.state));
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
  const showCategory = section.rows.some((row) => row.category !== null);
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
          <IntegrationRowItem key={row.key} row={row} showCategory={showCategory} t={t} />
        ))}
      </ul>
    </section>
  );
}

export function IntegrationsCatalog({ integrations }: { integrations: ProjectIntegrations }) {
  const t = useTranslations();
  const sections = useMemo(() => integrationSections(integrations, t), [integrations, t]);

  return (
    <div className="w-full space-y-10">
      {sections.map((section) => (
        <IntegrationSectionBlock key={section.family} section={section} t={t} />
      ))}
    </div>
  );
}
