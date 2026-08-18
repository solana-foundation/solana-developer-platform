import { EarnButtonBuilder } from "../earn-button-builder";
import { loadEarnProviderAccess } from "../earn-provider-access.server";

/** Provider access is organization-scoped and must be resolved per request. */
export const dynamic = "force-dynamic";

export default async function EarnButtonBuilderPage({
  searchParams,
}: {
  searchParams: Promise<{ strategy?: string | string[] }>;
}) {
  const [{ strategy }, providerAccess] = await Promise.all([
    searchParams,
    loadEarnProviderAccess(),
  ]);
  return (
    <EarnButtonBuilder
      earnHref="/dashboard/markets/earn"
      providerAccess={providerAccess}
      strategyId={typeof strategy === "string" ? strategy : undefined}
    />
  );
}
