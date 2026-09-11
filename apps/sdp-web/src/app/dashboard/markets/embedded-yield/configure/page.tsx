import { SOLANA_CLUSTERS } from "@sdp/types";
import { DASHBOARD_MARKETS_SUBNAV_HREFS } from "@/lib/dashboard-navigation-loading";
import { isSelectedProjectSandbox } from "@/lib/server-sdp-environment";
import { resolvePlaygroundApiBaseUrl } from "../../../playground-api-data";
import { EarnIntegrationGuide } from "../../earn/earn-integration-guide";
import { loadEarnProviderAccess } from "../../earn/earn-provider-access.server";

export const dynamic = "force-dynamic";

export default async function EmbeddedYieldConfigurePage({
  searchParams,
}: {
  searchParams: Promise<{ cluster?: string | string[]; strategy?: string | string[] }>;
}) {
  const [{ cluster, strategy }, sandbox] = await Promise.all([
    searchParams,
    isSelectedProjectSandbox(),
  ]);
  const providerAccess = sandbox ? null : await loadEarnProviderAccess();
  const strategyCluster =
    typeof cluster === "string" ? SOLANA_CLUSTERS.find((value) => value === cluster) : undefined;
  return (
    <EarnIntegrationGuide
      apiBaseUrl={resolvePlaygroundApiBaseUrl()}
      earnHref={DASHBOARD_MARKETS_SUBNAV_HREFS.earnProgram}
      providerAccess={providerAccess}
      strategyCluster={strategyCluster}
      strategyId={typeof strategy === "string" && strategy !== "" ? strategy : undefined}
    />
  );
}
