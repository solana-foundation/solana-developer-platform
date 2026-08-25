import { ArrowRightIcon, LandmarkIcon, type LucideIcon, UsersRoundIcon } from "lucide-react";
import Link from "next/link";
import { DashboardWorkspaceOverviewPanel } from "@/components/dashboard-workspace-panel";
import {
  providerSelectionCardIconClassName,
  providerSelectionCardTitleClassName,
  providerSelectionCardTitleUnderlineClassName,
} from "@/components/ui/provider-selection-card";
import { getTranslations } from "@/i18n/server";
import { DASHBOARD_MARKETS_SUBNAV_HREFS } from "@/lib/dashboard-navigation-loading";
import { cn } from "@/lib/utils";

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
        <span className={providerSelectionCardIconClassName}>
          <Icon aria-hidden="true" className="h-5 w-5" />
        </span>
        <span className="min-w-0 flex-1 space-y-2">
          <span className="block text-xs font-medium uppercase tracking-wide text-tertiary">
            {audience}
          </span>
          <span
            className={cn(
              providerSelectionCardTitleClassName,
              "text-primary",
              providerSelectionCardTitleUnderlineClassName
            )}
          >
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
 * before either workspace loads. A server component with static links only;
 * the segment layout enforces the markets and earn gates for every surface it
 * offers, so nothing here checks a flag or fetches data.
 */
export async function MarketsLanding() {
  const t = await getTranslations();

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
