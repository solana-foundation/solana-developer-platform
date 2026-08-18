import { loadEarnProviderAccess } from "../earn/earn-provider-access.server";
import { TreasurySolutionsWorkspace } from "./treasury-solutions-workspace";

/** Provider access is organization-scoped and must be resolved per request. */
export const dynamic = "force-dynamic";

export default async function TreasurySolutionsPage() {
  const providerAccess = await loadEarnProviderAccess();
  return <TreasurySolutionsWorkspace providerAccess={providerAccess} />;
}
