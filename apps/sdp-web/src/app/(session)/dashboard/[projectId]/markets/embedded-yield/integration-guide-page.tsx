import { EarnIntegrationGuide } from "@/app/(session)/dashboard/[projectId]/markets/earn/earn-integration-guide";
import { resolvePlaygroundApiBaseUrl } from "@/app/(session)/dashboard/[projectId]/playground-api-data";

/**
 * The body shared by the Embedded Yield guide routes: Next.js requires one `page.tsx` per segment,
 * so the resolution lives here and each route stays a wrapper.
 */
export async function EarnIntegrationGuidePage({
  searchParams,
}: {
  searchParams: Promise<{ strategy?: string | string[] }>;
}) {
  const { strategy } = await searchParams;
  return (
    <EarnIntegrationGuide
      apiBaseUrl={resolvePlaygroundApiBaseUrl()}
      strategyId={typeof strategy === "string" && strategy !== "" ? strategy : undefined}
    />
  );
}
