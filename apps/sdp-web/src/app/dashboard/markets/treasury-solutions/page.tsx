import { isSelectedProjectSandbox } from "@/lib/server-sdp-environment";
import { loadEarnProviderAccess } from "../earn/earn-provider-access.server";
import { TreasurySolutionsWorkspace } from "./treasury-solutions-workspace";

/** Provider access is organization-scoped and must be resolved per request. */
export const dynamic = "force-dynamic";

export default async function TreasurySolutionsPage() {
  // The sandbox client never needs provider entitlement and, more importantly,
  // must not start a live Devnet provider path before it can choose LocalStorage.
  const providerAccess = (await isSelectedProjectSandbox()) ? null : await loadEarnProviderAccess();
  return <TreasurySolutionsWorkspace providerAccess={providerAccess} />;
}
