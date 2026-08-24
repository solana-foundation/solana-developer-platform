"use client";

import { ArrowRightIcon, LandmarkIcon, type LucideIcon, UsersRoundIcon } from "lucide-react";
import Link from "next/link";
import { DashboardWorkspaceOverviewPanel } from "@/components/dashboard-workspace-panel";
import { useTranslations } from "@/i18n/provider";
import { DASHBOARD_MARKETS_SUBNAV_HREFS } from "@/lib/dashboard-navigation-loading";

function MarketsPathCard({
  audience,
  description,
  href,
  icon: Icon,
  title,
}: {
  audience: string;
  description: string;
  href: string;
  icon: LucideIcon;
  title: string;
}) {
  return (
    <Link
      className="group flex h-full items-center justify-between gap-5 rounded-2xl border border-border-default bg-surface-raised p-6 transition-colors hover:bg-fill-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-default focus-visible:ring-offset-2"
      href={href}
    >
      <span className="flex min-w-0 items-start gap-4">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-fill-strong text-primary">
          <Icon aria-hidden="true" className="h-5 w-5" />
        </span>
        <span className="min-w-0 flex-1 space-y-2">
          <span className="block text-xs font-medium uppercase tracking-wide text-tertiary">
            {audience}
          </span>
          <span className="relative inline-block text-[22px] leading-none font-medium text-primary after:absolute after:left-0 after:-bottom-1 after:h-px after:w-0 after:bg-current after:transition-[width] after:duration-200 group-hover:after:w-full group-focus-visible:after:w-full motion-reduce:after:transition-none">
            {title}
          </span>
          <span className="block max-w-md pt-0.5 text-sm leading-6 text-tertiary">
            {description}
          </span>
        </span>
      </span>
      <ArrowRightIcon
        aria-hidden="true"
        className="h-4 w-4 shrink-0 text-tertiary transition duration-200 group-hover:translate-x-0.5 group-hover:text-primary motion-reduce:transition-none"
      />
    </Link>
  );
}

/**
 * The Markets entry chooser: routes a visitor to the surface built for them
 * before either workspace loads. Static links only. The segment layout gates
 * markets and the page gates earn, so the cards never offer a destination the
 * visitor cannot open.
 */
export function MarketsLanding() {
  const t = useTranslations();

  return (
    <DashboardWorkspaceOverviewPanel>
      <div className="mx-auto w-full max-w-4xl space-y-5">
        <div className="max-w-3xl">
          <p className="text-xs font-medium uppercase tracking-wide text-tertiary">
            {t("DashboardMarkets.landing.eyebrow")}
          </p>
          <p className="mt-2 text-sm leading-6 text-secondary">
            {t("DashboardMarkets.landing.description")}
          </p>
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          <MarketsPathCard
            audience={t("DashboardMarkets.landing.treasuryAudience")}
            description={t("DashboardMarkets.landing.treasuryDescription")}
            href={DASHBOARD_MARKETS_SUBNAV_HREFS.treasurySolutions}
            icon={LandmarkIcon}
            title={t("Shared.dashboardShell.treasurySolutions")}
          />
          <MarketsPathCard
            audience={t("DashboardMarkets.landing.programAudience")}
            description={t("DashboardMarkets.landing.programDescription")}
            href={DASHBOARD_MARKETS_SUBNAV_HREFS.earnProgram}
            icon={UsersRoundIcon}
            title={t("Shared.dashboardShell.earnProgram")}
          />
        </div>
      </div>
    </DashboardWorkspaceOverviewPanel>
  );
}
