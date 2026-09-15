import { DASHBOARD_MARKETS_SUBNAV_HREFS } from "@/lib/dashboard-navigation-loading";
import { resolvePlaygroundApiBaseUrl } from "../../../playground-api-data";
import { EarnIntegrationGuide } from "../../earn/earn-integration-guide";
import { loadEarnProviderAccess } from "../../earn/earn-provider-access.server";

/** Provider access is organization-scoped and must be resolved per request. */
export const dynamic = "force-dynamic";

export default async function EmbeddedYieldIntegratePage({
  searchParams,
}: {
  searchParams: Promise<{ strategy?: string | string[] }>;
}) {
  const [{ strategy }, providerAccess] = await Promise.all([
    searchParams,
    loadEarnProviderAccess(),
  ]);
  return (
    <EarnIntegrationGuide
      apiBaseUrl={resolvePlaygroundApiBaseUrl()}
      earnHref={DASHBOARD_MARKETS_SUBNAV_HREFS.earnProgram}
      providerAccess={providerAccess}
      strategyId={typeof strategy === "string" && strategy !== "" ? strategy : undefined}
    />
  );
}
