import { EarnProgramWorkspace } from "./earn-program-workspace";
import { loadEarnProviderAccess } from "./earn-provider-access.server";

/** Provider access is organization-scoped and must be resolved per request. */
export const dynamic = "force-dynamic";

export default async function EarnPage() {
  const providerAccess = await loadEarnProviderAccess();
  return (
    <EarnProgramWorkspace
      builderHref="/dashboard/markets/earn/button-builder"
      providerAccess={providerAccess}
    />
  );
}
