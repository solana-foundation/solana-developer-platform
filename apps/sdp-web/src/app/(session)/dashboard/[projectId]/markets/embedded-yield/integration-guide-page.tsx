import { EarnIntegrationGuide } from "@/app/(session)/dashboard/[projectId]/markets/earn/earn-integration-guide";
import { loadEarnProviderAccess } from "@/app/(session)/dashboard/[projectId]/markets/earn/earn-provider-access.server";
import { findPublicSdpApiBaseUrl } from "@/lib/sdp-api-base-url";

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
  // The guide's snippet is copied into a partner's codebase, so it names only an
  // address their environment can reach: `SDP_API_BASE_URL` may resolve just inside
  // ours (e.g. `http://sdp-api:8787` in the self-hosted compose).
  const apiBaseUrl = findPublicSdpApiBaseUrl({
    NEXT_PUBLIC_SDP_API_BASE_URL: process.env.NEXT_PUBLIC_SDP_API_BASE_URL,
    NEXT_PUBLIC_API_BASE_URL: process.env.NEXT_PUBLIC_API_BASE_URL,
  });
  return (
    <EarnIntegrationGuide
      apiBaseUrl={apiBaseUrl}
      providerAccess={providerAccess}
      strategyId={typeof strategy === "string" && strategy !== "" ? strategy : undefined}
    />
  );
}
