import { getSelectedProjectId } from "@/lib/sdp-api";
import { EarnButtonBuilder } from "../earn-button-builder";
import { loadEarnButtonConfiguration } from "../earn-button-configuration.server";
import { loadEarnProviderAccess } from "../earn-provider-access.server";

/** Provider access is organization-scoped and must be resolved per request. */
export const dynamic = "force-dynamic";

export default async function EarnButtonBuilderPage({
  searchParams,
}: {
  searchParams: Promise<{ strategy?: string | string[] }>;
}) {
  const [{ strategy }, providerAccess, configuration, projectId] = await Promise.all([
    searchParams,
    loadEarnProviderAccess(),
    loadEarnButtonConfiguration(),
    getSelectedProjectId(),
  ]);
  return (
    <EarnButtonBuilder
      earnHref="/dashboard/markets/earn"
      configurationLoad={configuration}
      key={projectId ?? "no-project"}
      providerAccess={providerAccess}
      strategyId={typeof strategy === "string" ? strategy : undefined}
    />
  );
}
