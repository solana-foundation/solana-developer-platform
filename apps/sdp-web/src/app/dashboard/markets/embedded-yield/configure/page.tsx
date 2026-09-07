import { SOLANA_CLUSTERS } from "@sdp/types";
import { DASHBOARD_MARKETS_SUBNAV_HREFS } from "@/lib/dashboard-navigation-loading";
import { resolvePlaygroundApiBaseUrl } from "../../../playground-api-data";
import { EarnIntegrationGuide } from "../../earn/earn-integration-guide";
import { loadEarnProviderAccess } from "../../earn/earn-provider-access.server";

export const dynamic = "force-dynamic";

export default async function EmbeddedYieldConfigurePage({
  searchParams,
}: {
  searchParams: Promise<{ cluster?: string | string[]; strategy?: string | string[] }>;
}) {
  const [{ cluster, strategy }, providerAccess] = await Promise.all([
    searchParams,
    loadEarnProviderAccess(),
  ]);
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
