import { ArrowLeftRightIcon, LandmarkIcon, UsersRoundIcon } from "lucide-react";
import type { ReactNode } from "react";
import { DashboardWorkspaceOverviewPanel } from "@/components/dashboard-workspace-panel";
import { RecordStack } from "@/components/refresh-record";
import { ActionTile } from "@/components/ui/action-tile";
import { dvp, earn } from "@/flags";
import { getTranslations } from "@/i18n/server";
import { DASHBOARD_MARKETS_SUBNAV_HREFS } from "@/lib/dashboard-navigation-loading";
import { requestProjectHref } from "@/lib/sdp-api";

/**
 * One group of paths: an 18px heading over its tiles, two to a row as Payments sets its
 * actions. The heading names the section for assistive tech.
 */
function MarketsPathGroup({
  headingId,
  title,
  children,
}: {
  headingId: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <section aria-labelledby={headingId} className="flex min-w-0 flex-col gap-4">
      <h2 className="text-subheading font-medium text-primary" id={headingId}>
        {title}
      </h2>
      <div className="grid min-w-0 grid-cols-2 gap-2">{children}</div>
    </section>
  );
}

/**
 * The Markets entry chooser: routes a visitor to the surface built for them
 * before either workspace loads. Markets runs when Earn or DvP does, so each
 * section shows only when its sub-module's flag (capped at the release channel)
 * is on: the same check its segment layout 404s on.
 */
export async function MarketsLanding() {
  const [t, earnEnabled, dvpEnabled, treasuryHref, earnProgramHref, dvpHref] = await Promise.all([
    getTranslations(),
    earn(),
    dvp(),
    requestProjectHref(DASHBOARD_MARKETS_SUBNAV_HREFS.treasurySolutions),
    requestProjectHref(DASHBOARD_MARKETS_SUBNAV_HREFS.earnProgram),
    requestProjectHref(DASHBOARD_MARKETS_SUBNAV_HREFS.dvp),
  ]);

  return (
    <DashboardWorkspaceOverviewPanel>
      <RecordStack>
        {earnEnabled ? (
          <MarketsPathGroup
            headingId="markets-earn-heading"
            title={t("DashboardMarkets.landing.earnHeading")}
          >
            <ActionTile
              href={treasuryHref}
              icon={LandmarkIcon}
              label={t("Shared.dashboardShell.treasurySolutions")}
              description={t("DashboardMarkets.landing.treasuryTileDescription")}
            />
            <ActionTile
              href={earnProgramHref}
              icon={UsersRoundIcon}
              label={t("Shared.dashboardShell.earnProgram")}
              description={t("DashboardMarkets.landing.programTileDescription")}
            />
          </MarketsPathGroup>
        ) : null}
        {dvpEnabled ? (
          <MarketsPathGroup
            headingId="markets-settlement-heading"
            title={t("DashboardMarkets.landing.settlementHeading")}
          >
            <ActionTile
              href={dvpHref}
              icon={ArrowLeftRightIcon}
              label={t("DashboardMarkets.dvp.navLabel")}
              description={t("DashboardMarkets.dvp.landingTileDescription")}
            />
          </MarketsPathGroup>
        ) : null}
      </RecordStack>
    </DashboardWorkspaceOverviewPanel>
  );
}
