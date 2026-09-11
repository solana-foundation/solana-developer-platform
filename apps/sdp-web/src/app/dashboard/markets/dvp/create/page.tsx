import { withDashboardPageTrace } from "@/lib/dashboard-page-trace";
import { isSelectedProjectSandbox } from "@/lib/server-sdp-environment";
import { fetchDvpCreateContext } from "./dvp-create.data";
import { DvpCreateClient } from "./dvp-create-client";

/** Wallets and issued tokens are project-scoped and change; never cache them. */
export const dynamic = "force-dynamic";

export default async function DvpCreatePage() {
  if (await isSelectedProjectSandbox()) {
    return <DvpCreateClient />;
  }
  return withDashboardPageTrace("dashboard.dvp.create.page", async ({ apiClient }) => {
    const context = await fetchDvpCreateContext(apiClient.request);
    return <DvpCreateClient context={context} />;
  });
}
