import { EarnIntegrationGuide } from "@/app/(session)/dashboard/[projectId]/markets/earn/earn-integration-guide";
import { loadEarnProviderAccess } from "@/app/(session)/dashboard/[projectId]/markets/earn/earn-provider-access.server";
import { resolvePlaygroundApiBaseUrl } from "@/app/(session)/dashboard/[projectId]/playground-api-data";

/**
 * The configure route's body (`EarnIntegrationGuide`): Next.js requires one
 * `page.tsx` per segment, so the resolution lives here and the route stays a
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
      providerAccess={providerAccess}
      strategyId={typeof strategy === "string" && strategy !== "" ? strategy : undefined}
    />
  );
}
