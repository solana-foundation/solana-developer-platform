import { DASHBOARD_MARKETS_SUBNAV_HREFS } from "@/lib/dashboard-navigation-loading";
import { EmbeddedYieldDashboard } from "../earn/embedded-yield-dashboard";

export default function EmbeddedYieldPage() {
  return (
    <EmbeddedYieldDashboard
      configureHref={`${DASHBOARD_MARKETS_SUBNAV_HREFS.earnProgram}/configure`}
    />
  );
}
