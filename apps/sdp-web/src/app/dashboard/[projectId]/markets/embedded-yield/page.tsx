import { EmbeddedYieldDashboard } from "@/app/dashboard/[projectId]/markets/earn/embedded-yield-dashboard";
import { DASHBOARD_MARKETS_SUBNAV_HREFS } from "@/lib/dashboard-navigation-loading";

export default function EmbeddedYieldPage() {
  return (
    <EmbeddedYieldDashboard
      configureHref={`${DASHBOARD_MARKETS_SUBNAV_HREFS.earnProgram}/configure`}
    />
  );
}
