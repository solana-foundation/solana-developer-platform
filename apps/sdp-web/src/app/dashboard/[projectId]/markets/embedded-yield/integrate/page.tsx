import { EarnIntegrationGuidePage } from "../integration-guide-page";

/** Provider access is organization-scoped and must be resolved per request. */
export const dynamic = "force-dynamic";

export default async function EmbeddedYieldIntegratePage({
  searchParams,
}: {
  searchParams: Promise<{ strategy?: string | string[] }>;
}) {
  return <EarnIntegrationGuidePage searchParams={searchParams} />;
}
