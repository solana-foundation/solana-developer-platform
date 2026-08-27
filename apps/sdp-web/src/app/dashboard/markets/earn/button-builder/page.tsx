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
  const configurationKey =
    configuration.kind === "ready" && configuration.configuration
      ? `${projectId ?? "no-project"}:${configuration.configuration.id}:${configuration.configuration.updatedAt}`
      : `${projectId ?? "no-project"}:${configuration.kind}`;
  return (
    <EarnButtonBuilder
      earnHref="/dashboard/markets/earn"
      configurationLoad={configuration}
      key={configurationKey}
      projectId={projectId ?? null}
      providerAccess={providerAccess}
      strategyId={typeof strategy === "string" && strategy !== "" ? strategy : undefined}
    />
  );
}
