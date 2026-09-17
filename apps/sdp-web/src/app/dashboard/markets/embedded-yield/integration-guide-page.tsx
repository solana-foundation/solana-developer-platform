import { DASHBOARD_MARKETS_SUBNAV_HREFS } from "@/lib/dashboard-navigation-loading";
import { resolvePlaygroundApiBaseUrl } from "../../playground-api-data";
import { EarnIntegrationGuide } from "../earn/earn-integration-guide";
import { loadEarnProviderAccess } from "../earn/earn-provider-access.server";

/**
 * The body shared by the two Embedded Yield guide routes (`configure` and
 * `integrate`): Next.js requires one `page.tsx` per segment, but both segments
 * render exactly this, so the resolution lives here and each route stays a
 * wrapper.
 */
export async function EarnIntegrationGuidePage({
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
