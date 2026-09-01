import { SOLANA_CLUSTERS } from "@sdp/types";
import { DASHBOARD_MARKETS_SUBNAV_HREFS } from "@/lib/dashboard-navigation-loading";
import { EarnProgramWorkspace } from "../../earn/earn-program-workspace";
import { loadEarnProviderAccess } from "../../earn/earn-provider-access.server";

export const dynamic = "force-dynamic";

export default async function EmbeddedYieldConfigurePage({
  searchParams,
}: {
  searchParams: Promise<{ cluster?: string | string[] }>;
}) {
  const [{ cluster }, providerAccess] = await Promise.all([searchParams, loadEarnProviderAccess()]);
  const initialCluster =
    typeof cluster === "string" ? SOLANA_CLUSTERS.find((value) => value === cluster) : undefined;
  return (
    <EarnProgramWorkspace
      initialCluster={initialCluster}
      integrateHref={`${DASHBOARD_MARKETS_SUBNAV_HREFS.earnProgram}/integrate`}
      providerAccess={providerAccess}
    />
  );
}
