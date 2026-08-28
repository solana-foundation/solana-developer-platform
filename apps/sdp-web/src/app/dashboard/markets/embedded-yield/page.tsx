import { DASHBOARD_MARKETS_SUBNAV_HREFS } from "@/lib/dashboard-navigation-loading";
import { EarnProgramWorkspace } from "../earn/earn-program-workspace";
import { loadEarnProviderAccess } from "../earn/earn-provider-access.server";

/** Provider access is organization-scoped and must be resolved per request. */
export const dynamic = "force-dynamic";

export default async function EmbeddedYieldPage() {
  const providerAccess = await loadEarnProviderAccess();
  return (
    <EarnProgramWorkspace
      builderHref={`${DASHBOARD_MARKETS_SUBNAV_HREFS.earnProgram}/button-builder`}
      providerAccess={providerAccess}
    />
  );
}
